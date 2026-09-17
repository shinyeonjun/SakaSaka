use std::env;
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

fn valid_secret(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.chars().any(|ch| matches!(ch, '\r' | '\n' | '\0'))
}

fn read_desktop_decision_settings(app: &AppHandle) -> Result<(String, String, Option<String>), String> {
    let path = decision_settings_path(app)?;
    if !path.exists() { return Ok(("codex-cli".into(), "jev-latest".into(), None)); }
    let raw = read_to_string(&path).map_err(|error| format!("판단 설정을 읽을 수 없습니다: {error}"))?;
    let provider = json_string_field(&raw, "provider").filter(|value| valid_provider(value)).unwrap_or_else(|| "codex-cli".into());
    let model = json_string_field(&raw, "jevModel").filter(|value| valid_model(value)).unwrap_or_else(|| "jev-latest".into());
    let key = json_string_field(&raw, "jevApiKey").filter(|value| valid_secret(value));
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
    if supplied.as_ref().is_some_and(|value| !valid_secret(value)) {
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

fn user_home_dir() -> PathBuf {
    env::var_os("USERPROFILE")
        .or_else(|| env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("~"))
}

fn non_empty_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn default_native_codex_home(is_windows: bool, local_app_data: Option<&Path>, home: &Path) -> PathBuf {
    if is_windows {
        local_app_data.unwrap_or(home).join("SakaSaka").join("codex-native")
    } else {
        home.join(".sakasaka").join("codex-native")
    }
}

/// Native work must never silently inherit the user's global Codex config.
/// An explicit SAKASAKA_CODEX_HOME remains supported for existing installations;
/// otherwise use SakaSaka's own persistent native home.
fn native_codex_home() -> PathBuf {
    if let Some(configured) = non_empty_env_path("SAKASAKA_CODEX_HOME") {
        return configured;
    }
    let local_app_data = non_empty_env_path("LOCALAPPDATA");
    default_native_codex_home(cfg!(windows), local_app_data.as_deref(), &user_home_dir())
}

fn codex_home_path() -> PathBuf {
    native_codex_home()
}

fn apply_codex_home(command: &mut Command, home: &Path) {
    command.env("SAKASAKA_CODEX_HOME", home).env("CODEX_HOME", home);
}

fn codex_binary_label() -> String {
    env::var("CODEX_CLI_BIN").ok().filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "codex".into())
}

fn build_codex_command(args: &[&str]) -> Command {
    let mut command = if let Ok(configured) = env::var("CODEX_CLI_BIN") {
        if !configured.trim().is_empty() {
            let mut command = Command::new(configured);
            command.args(args);
            command
        } else if cfg!(windows) {
            let mut command = Command::new("cmd.exe");
            let line = if args.is_empty() { "codex".to_string() } else { format!("codex {}", args.join(" ")) };
            command.args(["/D", "/S", "/C", &line]);
            command
        } else {
            let mut command = Command::new("codex");
            command.args(args);
            command
        }
    } else if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        let line = if args.is_empty() { "codex".to_string() } else { format!("codex {}", args.join(" ")) };
        command.args(["/D", "/S", "/C", &line]);
        command
    } else {
        let mut command = Command::new("codex");
        command.args(args);
        command
    };
    let home = codex_home_path();
    apply_codex_home(&mut command, &home);
    command
}

fn command_text(command: &mut Command) -> Result<(bool, String), String> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let summary = format!("{} {}", stdout, stderr).split_whitespace().collect::<Vec<_>>().join(" ");
    Ok((output.status.success(), summary.chars().take(240).collect()))
}

fn codex_environment_status_json() -> Result<String, String> {
    let binary = codex_binary_label();
    let home = codex_home_path().to_string_lossy().to_string();
    let version = command_text(&mut build_codex_command(&["--version"]));
    let (version_ok, version_text) = match version {
        Ok(value) => value,
        Err(_) => {
            return Ok(format!(
                "{{\"installed\":false,\"binary\":\"{}\",\"authState\":\"missing\",\"codexHome\":\"{}\",\"persistent\":false,\"detail\":\"{}\"}}",
                json_escape(&binary), json_escape(&home), json_escape("Codex CLI를 찾지 못했습니다. 설치 후 한 번만 로그인하면 이후 실행에서는 Codex의 기존 인증을 재사용합니다.")
            ));
        }
    };
    if !version_ok {
        return Ok(format!(
            "{{\"installed\":false,\"binary\":\"{}\",\"authState\":\"missing\",\"codexHome\":\"{}\",\"persistent\":false,\"detail\":\"{}\"}}",
            json_escape(&binary), json_escape(&home), json_escape("Codex CLI를 실행하지 못했습니다. PATH와 설치 상태를 확인하세요.")
        ));
    }

    let login = command_text(&mut build_codex_command(&["login", "status"])).unwrap_or((false, String::new()));
    let lower = login.1.to_lowercase();
    let (auth_state, auth_method, persistent, detail) = if lower.contains("not logged in") {
        ("missing", None, false, "Codex CLI는 설치되어 있지만 로그인이 필요합니다. 로그인은 Codex 자체 창에서 진행되며 SakaSaka에 비밀번호나 토큰이 저장되지 않습니다.")
    } else if lower.contains("logged in using chatgpt") {
        ("verified", Some("chatgpt"), true, "ChatGPT 로그인이 준비되어 있습니다. SakaSaka는 인증 토큰을 복사하지 않고 Codex가 관리하는 로그인 저장소를 그대로 재사용합니다.")
    } else if lower.contains("logged in using") && lower.contains("api key") {
        ("verified", Some("api-key"), true, "Codex API key 로그인이 준비되어 있습니다. 인증 저장소는 Codex가 직접 관리합니다.")
    } else if lower.contains("logged in using") && lower.contains("agent identity") {
        ("verified", Some("agent-identity"), true, "Codex Agent Identity 로그인이 준비되어 있습니다. 인증 저장소는 Codex가 직접 관리합니다.")
    } else if lower.contains("logged in") {
        ("verified", Some("unknown"), true, "Codex 로그인 상태를 확인했습니다. 인증 저장소는 Codex가 직접 관리합니다.")
    } else {
        ("unknown", None, false, "Codex CLI는 설치되어 있지만 로그인 상태를 확정하지 못했습니다. 다시 확인하거나 Codex 로그인을 진행하세요.")
    };
    let auth_field = auth_method.map(|method| format!(",\"authMethod\":\"{}\"", method)).unwrap_or_default();
    Ok(format!(
        "{{\"installed\":true,\"binary\":\"{}\",\"version\":\"{}\",\"authState\":\"{}\"{},\"codexHome\":\"{}\",\"persistent\":{},\"detail\":\"{}\"}}",
        json_escape(&binary), json_escape(&version_text), auth_state, auth_field, json_escape(&home), if persistent { "true" } else { "false" }, json_escape(detail)
    ))
}

#[tauri::command]
fn codex_environment_status() -> Result<String, String> {
    codex_environment_status_json()
}

fn install_codex_cli_sync() -> Result<String, String> {
    if let Ok(status) = codex_environment_status_json() {
        if status.contains("\"installed\":true") { return Ok(status); }
    }
    let mut command = Command::new(npm_binary());
    command.args(["install", "-g", "@openai/codex@latest"]);
    let (success, output) = command_text(&mut command).map_err(|error| format!("npm을 실행할 수 없습니다: {error}"))?;
    if !success { return Err(format!("Codex CLI 설치에 실패했습니다: {}", if output.is_empty() { "npm 전역 설치 실패" } else { &output })); }
    let status = codex_environment_status_json()?;
    if !status.contains("\"installed\":true") {
        return Err("설치는 완료됐지만 현재 앱에서 Codex CLI를 찾지 못했습니다. 앱을 다시 시작하거나 PATH를 확인하세요.".into());
    }
    Ok(status)
}

#[tauri::command]
async fn install_codex_cli() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(install_codex_cli_sync)
        .await
        .map_err(|error| format!("Codex 설치 작업을 완료하지 못했습니다: {error}"))?
}

fn launch_codex_login_terminal(method: &str) -> Result<(), String> {
    let command_line = if method == "device" { "codex login --device-auth" } else { "codex login" };
    let codex_home = codex_home_path();
    if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "start", "", "cmd.exe", "/K", command_line]);
        apply_codex_home(&mut command, &codex_home);
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        command.spawn().map_err(|error| format!("Codex 로그인 터미널을 열 수 없습니다: {error}"))?;
        return Ok(());
    }
    if cfg!(target_os = "macos") {
        let script = format!("tell application \"Terminal\" to do script \"{}\"", command_line.replace('"', "\\\""));
        let mut command = Command::new("osascript");
        command.args(["-e", &script]);
        apply_codex_home(&mut command, &codex_home);
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Codex 로그인 터미널을 열 수 없습니다: {error}"))?;
        return Ok(());
    }
    let mut command = Command::new("x-terminal-emulator");
    command.args(["-e", "sh", "-lc", &format!("{}; printf '\\n로그인이 끝났으면 이 창을 닫아도 됩니다.\\n'; exec sh", command_line)]);
    apply_codex_home(&mut command, &codex_home);
    command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("Codex 로그인 터미널을 열 수 없습니다: {error}"))?;
    Ok(())
}

#[tauri::command]
fn start_codex_login(method: String) -> Result<String, String> {
    if method != "browser" && method != "device" { return Err("지원하지 않는 Codex 로그인 방식입니다.".into()); }
    let status = codex_environment_status_json()?;
    if !status.contains("\"installed\":true") { return Err("먼저 Codex CLI를 설치하세요.".into()); }
    launch_codex_login_terminal(&method)?;
    Ok(status)
}

#[tauri::command]
fn codex_logout() -> Result<String, String> {
    let status = codex_environment_status_json()?;
    if !status.contains("\"installed\":true") { return Ok(status); }
    let (success, output) = command_text(&mut build_codex_command(&["logout"])).map_err(|error| format!("Codex 로그아웃을 실행할 수 없습니다: {error}"))?;
    if !success { return Err(format!("Codex 로그아웃에 실패했습니다: {}", if output.is_empty() { "codex logout 실패" } else { &output })); }
    codex_environment_status_json()
}

fn spawn_local_backend(app: &AppHandle, script: &str, data_dir: &Path) -> Result<BackendProcess, String> {
    let root = backend_root(app);
    let codex_home = native_codex_home();
    create_dir_all(&codex_home).map_err(|error| format!("SakaSaka 전용 Codex 홈을 만들 수 없습니다 ({codex_home:?}): {error}"))?;
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
        .env("SAKASAKA_CODEX_HOME", &codex_home)
        .env("CODEX_HOME", &codex_home)
        .env("INTENT_WORLD_STATE_FILE", data_dir.join("state.json"))
        .env("INTENT_WORLD_RAW_DIR", data_dir.join("raw"))
        .env("INTENT_WORLD_AUTONOMY_FILE", data_dir.join("autonomy.json"))
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
    let codex_home = native_codex_home();
    create_dir_all(&codex_home).map_err(|error| format!("SakaSaka 전용 Codex 홈을 만들 수 없습니다 ({codex_home:?}): {error}"))?;
    let command = app
        .shell()
        .sidecar(sidecar)
        .map_err(|error| format!("패키지된 백엔드 {sidecar}를 찾을 수 없습니다: {error}"))?
        .env("API_HOST", "127.0.0.1")
        .env("API_PORT", "8787")
        .env("DESKTOP_MODE", "true")
        .env("CODEX_CLI_ENABLED", "true")
        .env("SAKASAKA_CODEX_HOME", &codex_home)
        .env("CODEX_HOME", &codex_home)
        .env("INTENT_WORLD_STATE_FILE", data_dir.join("state.json"))
        .env("INTENT_WORLD_RAW_DIR", data_dir.join("raw"))
        .env("INTENT_WORLD_AUTONOMY_FILE", data_dir.join("autonomy.json"))
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
        .invoke_handler(tauri::generate_handler![
            decision_settings_status,
            save_decision_settings,
            codex_environment_status,
            install_codex_cli,
            start_codex_login,
            codex_logout,
        ])
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

#[cfg(test)]
mod tests {
    use super::default_native_codex_home;
    use std::path::Path;

    #[test]
    fn windows_native_home_is_scoped_to_sakasaka_local_data() {
        let local_app_data = Path::new(r"C:\Users\tester\AppData\Local");
        let home = Path::new(r"C:\Users\tester");
        assert_eq!(
            default_native_codex_home(true, Some(local_app_data), home),
            Path::new(r"C:\Users\tester\AppData\Local\SakaSaka\codex-native")
        );
    }

    #[test]
    fn native_home_does_not_default_to_global_codex_directory() {
        let home = Path::new(r"/home/tester");
        assert_eq!(
            default_native_codex_home(false, None, home),
            Path::new(r"/home/tester/.sakasaka/codex-native")
        );
    }
}
