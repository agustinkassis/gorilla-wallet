#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    net::{TcpListener, TcpStream},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread::sleep,
    time::{Duration, Instant},
};
use tauri::{webview::NewWindowResponse, window::Color, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// Preferred port: a stable origin keeps the webview's localStorage (selected wallet, theme) across launches.
const PORT: u16 = 47_291;

struct Server(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data = app.path().app_data_dir()?;
            fs::create_dir_all(&data)?;

            let port = TcpListener::bind(("127.0.0.1", PORT))
                .or_else(|_| TcpListener::bind(("127.0.0.1", 0)))?
                .local_addr()?
                .port();
            let child = start_server(&app.path().resource_dir()?.join("server"), &data, port)?;
            app.manage(Server(Mutex::new(Some(child))));
            // localhost: the same origin as earlier versions, so the webview keeps its localStorage
            let url: Url = format!("http://localhost:{port}").parse()?;
            let local = url.origin().ascii_serialization();
            // `tauri dev` serves the splash from its own dev server (http://127.0.0.1:1430), bundles from tauri://
            let dev_splash = app.config().build.dev_url.as_ref().map(|u| u.origin().ascii_serialization());
            // Opens at once on the bundled splash (splash/index.html) while the server starts, then moves to the app.
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Gorilla Wallet")
                .inner_size(1280.0, 840.0)
                .min_inner_size(380.0, 600.0)
                .background_color(Color(204, 4, 4, 255)) // the splash red: no white flash between pages
                // the app's boot screen (components/splash.tsx) only shows in the desktop app
                .initialization_script(format!(
                    "window.__GORILLA_NATIVE__ = true; window.__GORILLA_VERSION__ = {:?}",
                    app.package_info().version.to_string()
                ))
                // External links (explorers) open in the system browser.
                .on_navigation(move |u| {
                    // the splash: tauri://localhost (macOS, Linux), http://tauri.localhost (Windows) or the dev server
                    let origin = u.origin().ascii_serialization();
                    let splash = u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost") || dev_splash.as_ref() == Some(&origin);
                    let ours = splash || origin == local;
                    if !ours {
                        open_external(u);
                    }
                    ours
                })
                .on_new_window(|u, _| {
                    open_external(&u);
                    NewWindowResponse::Deny
                })
                // Let <a download> save to the Downloads folder (ignored by default on macOS / Linux).
                .on_download(|_, _| true)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = match wait_for_server(&handle, port) {
                    Ok(()) => window.navigate(url),
                    Err(e) => window.eval(format!("splashError({e:?})")),
                };
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Gorilla Wallet")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.try_state::<Server>().and_then(|s| s.0.lock().unwrap().take()) {
                    let _ = child.kill();
                }
            }
        });
}

/// Runs the bundled Next.js standalone server on the bundled Node (`gorilla-node`, next to our executable).
fn start_server(server: &Path, data: &Path, port: u16) -> std::io::Result<Child> {
    let node = std::env::current_exe()?.with_file_name(format!("gorilla-node{}", std::env::consts::EXE_SUFFIX));
    let log = fs::File::create(data.join("server.log"))?;
    let mut cmd = Command::new(node);
    cmd.arg(server.join("start.mjs"))
        .current_dir(server)
        .env("PORT", port.to_string())
        .env("HOSTNAME", "127.0.0.1")
        .env("NODE_ENV", "production")
        .env("DATABASE_URL", format!("file:{}", data.join("wallet.db").display()))
        .stdin(Stdio::piped()) // start.mjs exits when this pipe closes, so a crashed app never leaves the server behind
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    cmd.spawn()
}

fn wait_for_server(app: &AppHandle, port: u16) -> Result<(), String> {
    let started = Instant::now();
    while TcpStream::connect(("127.0.0.1", port)).is_err() {
        let state = app.state::<Server>();
        if let Some(status) = state.0.lock().unwrap().as_mut().and_then(|c| c.try_wait().ok().flatten()) {
            return Err(format!("The wallet server stopped ({status}). See server.log in the app data folder."));
        }
        if started.elapsed() > Duration::from_secs(60) {
            return Err("The wallet server didn't start within 60 s. See server.log in the app data folder.".into());
        }
        sleep(Duration::from_millis(50));
    }
    Ok(())
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = open::that_detached(url.as_str());
    }
}
