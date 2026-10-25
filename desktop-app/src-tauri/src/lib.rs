//! Taskly desktop shell (Tauri v2).
//!
//! v0 scope: a main window embedding the existing Taskly web UI, a tray icon
//! with right-click menu, a small settings file under the app data folder, a
//! local first-run screen for entering the Taskly server URL, and
//! registration of the `taskly://` deep-link scheme (routing arrives with
//! the OAuth pairing phase).
//!
//! The capture engine (audio, whisper.cpp, journal, pusher) plugs into this
//! shell in later phases — see desktop-app/README.md for the phase plan.

mod settings;
mod setup_screen;
mod tray;
mod window;

/// Runs the Tauri application. Called from `main.rs`.
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single instance FIRST: a second launch (e.g. clicking a `taskly://`
    // link or a shortcut while Taskly runs) must not open a second app.
    // Its `deep-link` feature also forwards the URL to this instance.
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        log_line("single-instance", &format!("second launch ignored: {argv:?}"));
        tray::show_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        // Local first-run screen: `/` renders the form, `/save?url=…`
        // validates + stores the URL and redirects to the web app.
        .register_uri_scheme_protocol(setup_screen::SCHEME, |context, request| {
            setup_screen::handle_request(context, request)
        })
        // Applies to every window: the close button hides to tray, "Quit"
        // lives in the tray menu only.
        .on_window_event(window::handle_window_event)
        .setup(|app| {
            setup_deep_links(app)?;
            tray::create_tray(app.handle())?;
            let settings = settings::load_or_default(app.handle());
            window::create_main_window(app.handle(), &settings)?;
            Ok(())
        });

    if let Err(error) = builder.run(tauri::generate_context!()) {
        // Only reached when the app cannot even start (e.g. WebView2
        // runtime missing); generate_context! config errors fail at compile
        // time. Print instead of unwrapping so startup is never a silent
        // abort, then exit undestructively.
        eprintln!("Taskly failed to start: {error}");
        std::process::exit(1);
    }
}

/// Registers the `taskly://` scheme handling.
#[cfg(desktop)]
fn setup_deep_links(app: &mut tauri::App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_deep_link::DeepLinkExt;

    // Windows/Linux: also register at runtime (HKCU registry on Windows),
    // which makes `taskly://` links work for dev builds too. macOS relies on
    // the bundle config from tauri.conf.json > plugins > deep-link.
    #[cfg(any(windows, target_os = "linux"))]
    app.deep_link().register_all()?;

    // Routing is wired in a later phase (OAuth redirect pairing). For now a
    // stray `taskly://` click only logs, proving the registration works.
    app.deep_link().on_open_url(|event| {
        let urls = event
            .urls()
            .iter()
            .map(|url| url.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        log_line("deep-link", &urls);
    });

    Ok(())
}

/// Minimal log helper. The release build ships the GUI subsystem, so this
/// output is only visible in dev runs until a proper logging sink
/// (tauri-plugin-log) is adopted in the engine phase.
pub fn log_line(tag: &str, message: &str) {
    eprintln!("[{tag}] {message}");
}
