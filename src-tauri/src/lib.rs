use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};

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
        .env("INTENT_WORLD_WORKSPACE_ROOT_FILE", data_dir.join("workspace-root.txt"))
        .env("WORKSPACE_ROOT", data_dir.join("workspaces"));
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("패키지된 백엔드 {sidecar}를 시작할 수 없습니다: {error}"))?;
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
