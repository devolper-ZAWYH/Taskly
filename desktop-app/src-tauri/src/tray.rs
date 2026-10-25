//! System tray icon and context menu.
//!
//! All tray/menu interaction lives in Rust (no JavaScript tray API is used),
//! so the capability file lists no `core:tray:*` permissions — those gate
//! JS-driven menus only. Start/stop capture are disabled placeholders until
//! the capture engine lands; todo wiring is in README.md.

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

use crate::log_line;
use crate::window::MAIN_WINDOW_LABEL;

/// Builds the tray icon + menu and registers it with the app.
pub fn create_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "Open Taskly").build(app)?;
    let start_capture = MenuItemBuilder::with_id("start_capture", "Start capture (soon)")
        .enabled(false)
        .build(app)?;
    let stop_capture = MenuItemBuilder::with_id("stop_capture", "Stop capture (soon)")
        .enabled(false)
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&start_capture)
        .item(&stop_capture)
        .separator()
        .item(&quit)
        .build()?;

    // Capture the handle for the click handler (avoids depending on
    // TrayIcon accessors inside the event closure).
    let app_handle = app.clone();
    let mut tray = TrayIconBuilder::with_id("taskly")
        .menu(&menu)
        // Right click shows the menu (default); left click shows the window
        // instead, so keep the menu off the left button.
        .show_menu_on_left_click(false)
        .tooltip("Taskly")
        .on_menu_event(|app, event| {
            if event.id() == "open" {
                show_window(app);
            } else if event.id() == "quit" {
                app.exit(0);
            }
            // start_capture / stop_capture are built disabled; a click
            // cannot reach here until the engine phase enables them.
        })
        .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_window(&app_handle);
            }
        });

    // Reuse the bundle's default window icon for now — one icon set to
    // maintain until dedicated tray artwork lands with the engine phase.
    match app.default_window_icon() {
        Some(icon) => tray = tray.icon(icon.clone()),
        None => log_line("tray", "no default window icon; tray shows a blank icon"),
    }

    tray.build(app)?;
    Ok(())
}

/// Shows (never recreates) the main window and gives it focus.
pub fn show_window<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => {
            if let Err(error) = window.show() {
                log_line("tray", &format!("show failed: {error}"));
            }
            if let Err(error) = window.unminimize() {
                log_line("tray", &format!("unminimize failed: {error}"));
            }
            if let Err(error) = window.set_focus() {
                log_line("tray", &format!("set_focus failed: {error}"));
            }
        }
        None => log_line("tray", "main window not found; nothing to open"),
    }
}
