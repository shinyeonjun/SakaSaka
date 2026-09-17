use std::fs::{create_dir_all, read_to_string, remove_file, rename, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;

enum BackendProcess {
    Local(Child),
    Packaged(CommandChild),
}

struct BackendProcesses(Mutex<Vec<BackendProcess>>);

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn backend_root(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        repository_root()
    } else {
        app.path().resource_dir().unwrap_or_else(|_| repository_root())
    }
}

fn npm_binary() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

fn log_file(data_dir: &Path) -> Result<std::fs::File, String> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("backend.log"))
        .map_err(|error| format!("백엔드 로그 파일을 열 수 없습니다: {error}"))
}

fn decision_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("앱 데이터 폴더를 확인할 수 없습니다: {error}"))?;
    create_dir_all(&data_dir).map_err(|error| format!("앱 데이터 폴더를 만들 수 없습니다: {error}"))?;
    Ok(data_dir.join("decision-settings.json"))
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            ch if ch.is_control() => escaped.push_str(&format!("\\u{:04x}", ch as u32)),
            ch => escaped.push(ch),
        }
    }
    escaped
}

fn json_string_field(raw: &str, key: &str) -> Option<String> {
    let needle = format!("\"{}\"", key);
    let key_index = raw.find(&needle)?;
    let after_key = &raw[key_index + needle.len()..];
    let colon = after_key.find(':')?;
    let mut chars = after_key[colon + 1..].trim_start().chars();
    if chars.next()? != '"' { return None; }
    let mut value = String::new();
    let mut escaped = false;
    while let Some(ch) = chars.next() {
        if escaped {
            match ch {
                '"' => value.push('"'),
                '\\' => value.push('\\'),
                'n' => value.push('\n'),
                'r' => value.push('\r'),
                't' => value.push('\t'),
                'u' => {
                    let mut digits = String::new();
                    for _ in 0..4 { digits.push(chars.next()?); }
                    if let Ok(code) = u32::from_str_radix(&digits, 16) {
                        if let Some(decoded) = char::from_u32(code) { value.push(decoded); }
                    }
                }
                other => value.push(other),
            }
            escaped = false;
            continue;
        }
        match ch {
            '\\' => escaped = true,
            '"' => return Some(value),
            other => value.push(other),
        }
    }
    None
}

fn valid_model(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_alphanumeric() { return false; }
    bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(*byte, b'.' | b'_' | b':' | b'/' | b'-'))
}

fn valid_provider(value: &str) -> bool {
    matches!(value, "codex-cli" | "jev" | "hybrid")
}

fn read_desktop_decision_settings(app: &AppHandle) -> Result<(String, String, Option<String>), String> {
    let path = decision_settings_path(app)?;
    if !path.exists() { return Ok(("codex-cli".into(), "jev-latest".into(), None)); }
    let raw = read_to_string(&path).map_err(|error| format!("판단 설정을 읽을 수 없습니다: {error}"))?;
    let provider = json_string_field(&raw, "provider").filter(|value| valid_provider(value)).unwrap_or_else(|| "codex-cli".into());
    let model = json_string_field(&raw, "jevModel").filter(|value| valid_model(value)).unwrap_or_else(|| "jev-latest".into());
    let key = json_string_field(&raw, "jevApiKey").filter(|value| !value.is_empty() && value.len() <= 4096 && !value.contains(['\r', '\n', '\0']));
    Ok((provider, model, key))
}

#[tauri::command]
fn decision_settings_status(app: AppHandle) -> Result<String, String> {
    let (provider, model, key) = read_desktop_decision_settings(&app)?;
    Ok(format!(
        "{{\"provider\":\"{}\",\"jevModel\":\"{}\",\"apiKeyConfigured\":{}}}",
        json_escape(&provider), json_escape(&model), if key.is_some() { "true" } else { "false" }
    ))
}

#[tauri::command]
fn save_decision_settings(
    app: AppHandle,
    provider: String,
    jev_model: String,
    jev_api_key: Option<String>,
    clear_jev_key: bool,
) -> Result<String, String> {
    let provider = provider.trim().to_lowercase();
    if !valid_provider(&provider) { return Err("지원하지 않는 decision provider입니다.".into()); }
    let model = jev_model.trim();
    if !valid_model(model) { return Err("Jev model id 형식이 올바르지 않습니다.".into()); }

    let (_, _, existing_key) = read_desktop_decision_settings(&app)?;
    let supplied = jev_api_key.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if supplied.as_ref().is_some_and(|value| value.len() > 4096 || value.contains(['\r', '\n', '\0'])) {
        return Err("Jev API key 형식이 올바르지 않습니다.".into());
    }
    let key = if clear_jev_key { None } else { supplied.or(existing_key) };
    if provider != "codex-cli" && key.is_none() { return Err("Jev 또는 hybrid를 사용하려면 TypeSafe API key가 필요합니다.".into()); }

    let path = decision_settings_path(&app)?;
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let updated = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let key_field = key.as_ref().map(|value| format!(",\n  \"jevApiKey\": \"{}\"", json_escape(value))).unwrap_or_default();
    let json = format!(
        "{{\n  \"version\": 1,\n  \"provider\": \"{}\",\n  \"jevModel\": \"{}\"{},\n  \"updatedAt\": \"desktop-{}\"\n}}\n",
        json_escape(&provider), json_escape(model), key_field, updated
    );

    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).map_err(|error| format!("판단 설정 임시 파일을 만들 수 없습니다: {error}"))?;
    file.write_all(json.as_bytes()).and_then(|_| file.sync_all()).map_err(|error| format!("판단 설정을 저장할 수 없습니다: {error}"))?;
    drop(file);

    #[cfg(windows)]
    if path.exists() { remove_file(&path).map_err(|error| format!("이전 판단 설정을 교체할 수 없습니다: {error}"))?; }
    rename(&temporary, &path).map_err(|error| format!("판단 설정을 적용할 수 없습니다: {error}"))?;

    decision_settings_status(app)
}

fn spawn_local_backend(app: &AppHandle, script: &str, data_dir: &Path) -> Result<BackendProcess, String> {
    let root = backend_root(app);
    let stdout = log_file(data_dir)?;
    let stderr = stdout
        .try_clone()
        .map_err(|error| format!("백엔드 로그 스트림을 만들 수 없습니다: {error}"))?;
    let mut command = Command::new(npm_binary());
    command
        .current_dir(&root)
        .args(["run", script])
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", "8787")
        .env("DESKTOP_MODE", "true")
        .env("CODEX_CLI_ENABLED", "true")
        .env("INTENT_WORLD_STATE_FILE", data_dir.join("state.json"))
        .env("INTENT_WORLD_RAW_DIR", data_dir.join("raw"))
        .env("INTENT_WORLD_DECISION_SETTINGS_FILE", data_dir.join("decision-settings.json"))
        .env("INTENT_WORLD_WORKSPACE_ROOT_FILE", data_dir.join("workspace-root.txt"))
        .env("WORKSPACE_ROOT", data_dir.join("workspaces"))
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }

    command
        .spawn()
        .map(BackendProcess::Local)
        .map_err(|error| format!("npm run {script}를 시작할 수 없습니다 ({root:?}): {error}"))
}

fn spawn_packaged_backend(app: &AppHandle, sidecar: &str, data_dir: &Path) -> Result<BackendProcess, String> {
    let command = app
        .shell()
        .sidecar(sidecar)
        .map_err(|error| format!("패키지된 백엔드 {sidecar}를 찾을 수 없습니다: {error}"))?
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", "8787")
        .env("DESKTOP_MODE", "true")
        .env("CODEX_CLI_ENABLED", "true")
        .env("INTENT_WORLD_STATE_FILE", data_dir.join("state.json"))
        .env("INTENT_WORLD_RAW_DIR", data_dir.join("raw"))
        .env("INTENT_WORLD_DECISION_SETTINGS_FILE", data_dir.join("decision-settings.json"))
        .env("INTENT_WORLD_WORKSPACE_ROOT_FILE", data_dir.join("workspace-root.txt"))
        .env("WORKSPACE_ROOT", data_dir.join("workspaces"));
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("패키지된 백엔드 {sidecar}를 찾을 수 없습니다: {error}"))?;
    let log_path = data_dir.join("backend.log");
    tauri::async_runtime::spawn(async move {
        let Ok(mut log) = OpenOptions::new().create(true).append(true).open(log_path) else { return };
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    let _ = writeln!(log, "{}", String::from_utf8_lossy(&line));
                }
                _ => {}
            }
        }
    });
    Ok(BackendProcess::Packaged(child))
}

fn spawn_backend(app: &AppHandle, script: &str, sidecar: &str, data_dir: &Path) -> Result<BackendProcess, String> {
    if cfg!(debug_assertions) {
        spawn_local_backend(app, script, data_dir)
    } else {
        spawn_packaged_backend(app, sidecar, data_dir)
    }
}

fn stop_backend(processes: &BackendProcesses) {
    let Ok(mut children) = processes.0.lock() else { return };
    for child in children.drain(..) {
        match child {
            BackendProcess::Local(process) => {
                let mut process = process;
                let _ = process.kill();
                let _ = process.wait();
            }
            BackendProcess::Packaged(process) => {
                let _ = process.kill();
            }
        }
    }
}

fn stop_processes(processes: Vec<BackendProcess>) {
    stop_backend(&BackendProcesses(Mutex::new(processes)));
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![decision_settings_status, save_decision_settings])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("앱 데이터 폴더를 확인할 수 없습니다: {error}"))?;
            create_dir_all(data_dir.join("raw"))
                .and_then(|_| create_dir_all(data_dir.join("workspaces")))
                .map_err(|error| format!("앱 데이터 폴더를 만들 수 없습니다: {error}"))?;

            let mut children = Vec::new();
            for (script, sidecar) in [("api", "sakasaka-api"), ("worker", "sakasaka-worker")] {
                match spawn_backend(app.handle(), script, sidecar, &data_dir) {
                    Ok(child) => children.push(child),
                    Err(error) => {
                        stop_processes(children);
                        return Err(error.into());
                    }
                }
            }
            app.manage(BackendProcesses(Mutex::new(children)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("SakaSaka 데스크톱 앱을 초기화하지 못했습니다")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                stop_backend(&app.state::<BackendProcesses>());
            }
        });
}
