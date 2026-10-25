//! Minimal settings store for the Taskly desktop shell.
//!
//! One small JSON file in the app data directory — on Windows:
//! `C:\Users\<user>\AppData\Roaming\com.zawyh.taskly\config.json`
//! (Tauri resolves the exact per-platform path via `app_data_dir`).
//!
//! v0 keeps a single meaningful value: `server_url`, the base URL of the
//! Taskly web app the shell embeds. The hardcoded default is empty, which
//! makes the shell show the local first-run setup screen instead of
//! navigating anywhere. Writes go through a temp file + rename so a crash
//! mid-write can never leave a truncated config.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, Url};

const SETTINGS_FILE_NAME: &str = "config.json";

/// Settings file contents (see module docs for the exact path).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Base URL of the Taskly web app to embed. Empty string = unset, which
    /// routes the shell to the first-run setup screen.
    #[serde(default)]
    pub server_url: String,

    /// Unknown/future keys are preserved on round-trip instead of dropped
    /// when the shell rewrites the file.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug)]
pub enum SettingsError {
    /// No settings file yet — the caller treats this as defaults.
    NotFound,
    /// Io errors that are not simple absence (permissions etc.).
    Io(String),
    /// The file exists but is not valid JSON.
    Parse(String),
    /// Saving failed; the previous file (if any) is untouched thanks to the
    /// temp-file + rename write.
    Write(String),
}

impl std::fmt::Display for SettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SettingsError::NotFound => write!(f, "settings file does not exist yet"),
            SettingsError::Io(message) => write!(f, "io error: {message}"),
            SettingsError::Parse(message) => write!(f, "invalid settings file: {message}"),
            SettingsError::Write(message) => write!(f, "write failed: {message}"),
        }
    }
}

impl std::error::Error for SettingsError {}

/// Loads settings with the hardcoded defaults (empty server URL) whenever
/// the file is missing, unreadable or corrupt. This must never make the app
/// fail to start, so failures only log.
pub fn load_or_default<R: Runtime>(app: &AppHandle<R>) -> Settings {
    match load(app) {
        Ok(settings) => settings,
        Err(error) => {
            crate::log_line(
                "settings",
                &format!("{error}; continuing with defaults (empty server URL)"),
            );
            Settings::default()
        }
    }
}

/// Reads and parses the settings file.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<Settings, SettingsError> {
    let path = config_path(app)?;
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(SettingsError::NotFound);
        }
        Err(error) => return Err(SettingsError::Io(format!("{path:?}: {error}"))),
    };
    serde_json::from_str(&raw).map_err(|error| SettingsError::Parse(format!("{path:?}: {error}")))
}

/// Stores the (already validated) server URL, preserving other fields.
pub fn store<R: Runtime>(app: &AppHandle<R>, url: &Url) -> Result<(), SettingsError> {
    let mut settings = load_or_default(app);
    settings.server_url = url.to_string();
    let raw = serde_json::to_string_pretty(&settings)
        .map_err(|error| SettingsError::Write(format!("serialize: {error}")))?;

    let path = config_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| SettingsError::Write(format!("mkdir {parent:?}: {error}")))?;
    }
    let temporary = path.with_file_name(format!("{SETTINGS_FILE_NAME}.tmp"));
    std::fs::write(&temporary, &raw)
        .map_err(|error| SettingsError::Write(format!("{temporary:?}: {error}")))?;
    // std::fs::rename replaces an existing target on Windows as well.
    std::fs::rename(&temporary, &path)
        .map_err(|error| SettingsError::Write(format!("{path:?}: {error}")))?;
    Ok(())
}

/// Validates a user-supplied server URL: must be a valid absolute URL and
/// `https` (plain `http` is accepted only for local dev servers on the
/// loopback host). Returns the normalized `Url` or a readable reason.
pub fn parse_server_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("the URL is empty".to_string());
    }
    let url = Url::parse(trimmed).map_err(|error| format!("not a valid URL: {error}"))?;
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback_host(&url) => Ok(url),
        _ => Err("must be an https:// URL".to_string()),
    }
}

fn is_loopback_host(url: &Url) -> bool {
    match url.host_str() {
        Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("[::ffff:127.0.0.1]") => true,
        _ => false,
    }
}

fn config_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, SettingsError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| SettingsError::Io(format!("app data dir unavailable: {error}")))?;
    Ok(dir.join(SETTINGS_FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::parse_server_url;

    #[test]
    fn https_url_is_accepted() {
        assert!(parse_server_url("https://taskly.example.com/").is_ok());
    }

    #[test]
    fn localhost_http_is_accepted_for_dev() {
        assert!(parse_server_url("http://localhost:3100").is_ok());
    }

    #[test]
    fn remote_http_is_rejected() {
        assert!(parse_server_url("http://taskly.example.com").is_err());
    }

    #[test]
    fn schemeless_input_is_rejected_here() {
        // The setup screen prepends https:// before calling this.
        assert!(parse_server_url("taskly.example.com").is_err());
    }

    #[test]
    fn dangerous_schemes_are_rejected() {
        assert!(parse_server_url("file:///C:/Windows").is_err());
    }
}
