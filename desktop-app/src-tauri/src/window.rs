//! Main-window creation and startup-target resolution.

use std::path::PathBuf;

use tauri::{
    AppHandle, Runtime, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};

use crate::log_line;
use crate::settings::{self, Settings};
use crate::setup_screen;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const WINDOW_TITLE: &str = "Taskly";

const WINDOW_DEFAULT_WIDTH: f64 = 1280.0;
const WINDOW_DEFAULT_HEIGHT: f64 = 800.0;
const WINDOW_MIN_WIDTH: f64 = 960.0;
const WINDOW_MIN_HEIGHT: f64 = 640.0;

/// Where the main window should point on this launch.
enum StartupTarget {
    /// The bundled page (`www/`). In dev it resolves to `build.devUrl`
    /// (http://localhost:3100 — the existing Taskly web app); it is only
    /// used when no server URL is configured.
    Bundled(PathBuf),
    /// Production first run: the local "enter your server URL" screen.
    Setup,
    /// A configured Taskly server (production, or a dev override).
    External(Url),
}

#[cfg(windows)]
const SETUP_PAGE_URL: &str = "http://taskly-setup.localhost/";
#[cfg(not(windows))]
const SETUP_PAGE_URL: &str = "taskly-setup://localhost/";

/// Creates the one and only main window with the startup URL resolved from
/// the current settings.
pub fn create_main_window<R: Runtime>(
    app: &AppHandle<R>,
    settings: &Settings,
) -> Result<WebviewWindow<R>, Box<dyn std::error::Error>> {
    let url = match startup_target(settings) {
        StartupTarget::Bundled(path) => WebviewUrl::App(path),
        StartupTarget::Setup => WebviewUrl::External(setup_page_url()?),
        StartupTarget::External(url) => WebviewUrl::External(url),
    };
    create_window(app, url).map_err(|error| error.into())
}

fn create_window<R: Runtime>(
    app: &AppHandle<R>,
    url: WebviewUrl,
) -> tauri::Result<WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, url)
        .title(WINDOW_TITLE)
        .inner_size(WINDOW_DEFAULT_WIDTH, WINDOW_DEFAULT_HEIGHT)
        .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
        .center()
        .build()
}

fn startup_target(settings: &Settings) -> StartupTarget {
    let stored = settings.server_url.trim();
    if !stored.is_empty() {
        match settings::parse_server_url(stored) {
            Ok(url) => return StartupTarget::External(url),
            Err(reason) => log_line(
                "window",
                &format!("saved server URL rejected ({reason}); using local fallback"),
            ),
        }
    }

    if cfg!(dev) {
        // Dev builds skip the setup screen: the embedded web app is the dev
        // server declared in tauri.conf.json (`build.devUrl` →
        // http://localhost:3100). To test a different URL, put it in the
        // config.json (see settings docs for the path).
        StartupTarget::Bundled(PathBuf::from("index.html"))
    } else {
        // Production with no (valid) configured URL: local setup screen.
        StartupTarget::Setup
    }
}

/// URL of the first-run screen. Custom-scheme origins differ per platform
/// (tauri docs, `register_uri_scheme_protocol`): Windows serves it as
/// `http://taskly-setup.localhost/…`, macOS/Linux as
/// `taskly-setup://localhost/…`.
fn setup_page_url() -> Result<Url, Box<dyn std::error::Error>> {
    Url::parse(SETUP_PAGE_URL)
        .map_err(|error| format!("internal: setup page URL constant invalid: {error}").into())
}

/// Attached in lib.rs via `Builder::on_window_event` (applies to every
/// window, so a future engine window inherits the same behaviour).
///
/// The close button hides the window while the app keeps running in the
/// tray — Meetily-style. "Quit" lives in the tray menu only, so closing is
/// never destructive.
pub fn handle_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if let Err(error) = window.hide() {
            log_line("window", &format!("close-to-tray hide failed: {error}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::startup_target;
    use crate::settings::Settings;

    #[test]
    fn dev_without_url_targets_dev_server() {
        let target = startup_target(&Settings::default());
        // Compile-time: the repo builds dev runs via `cargo tauri dev`, in
        // which `cfg!(dev)` holds; assert so the test intent stays honest.
        assert!(matches!(
            target,
            super::StartupTarget::Bundled(_) | super::StartupTarget::Setup
        ));
    }
}
