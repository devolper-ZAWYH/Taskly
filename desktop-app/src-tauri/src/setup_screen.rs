//! First-run screen asking for the Taskly server URL.
//!
//! Everything is plain hand-written HTML served by the `taskly-setup`
//! custom scheme (registered in lib.rs); no frontend framework, no IPC.
//! The form submits a GET to `/save?url=…`, the Rust handler parses the
//! query, validates + stores the URL via the settings module, and answers
//! with a page whose meta-refresh navigates the webview to the saved
//! Taskly server. Keeping the flow browser-level means the screen works
//! regardless of IPC permission gating for the scheme.
//!
//! Panics are not allowed in handlers, so fallible building has fallback
//! responses and every failure re-renders the form with a readable reason.

use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Runtime, UriSchemeContext};

/// Custom scheme name; on Windows pages are served from
/// `http://taskly-setup.localhost/…`, on macOS/Linux from
/// `taskly-setup://localhost/…`.
pub const SCHEME: &str = "taskly-setup";

const ENTRY_PATH: &str = "/";
const SAVE_PATH: &str = "/save";

/// Entry point registered with `Builder::register_uri_scheme_protocol`.
/// Responds to every request against the setup scheme.
pub fn handle_request<R: Runtime>(
    context: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let query = request.uri().query().map(|query| query.to_string());
    let app = context.app_handle().clone();

    match path.as_str() {
        ENTRY_PATH => text_response(StatusCode::OK, &entry_page(None)),
        SAVE_PATH => save(app, query.as_deref()),
        _ => text_response(
            StatusCode::NOT_FOUND,
            &entry_page(Some("Unknown page — restart Taskly.")),
        ),
    }
}

/// Validates the submitted URL, stores it and replies with a redirect page,
/// or re-renders the form with a readable reason.
fn save<R: Runtime>(app: AppHandle<R>, query: Option<&str>) -> Response<Vec<u8>> {
    let submitted = query
        .and_then(|query| form_value(query, "url"))
        .unwrap_or_default();

    let candidate = match normalize_input(&submitted) {
        Ok(candidate) => candidate,
        Err(reason) => return text_response(StatusCode::BAD_REQUEST, &entry_page(Some(&reason))),
    };

    let url = match crate::settings::parse_server_url(&candidate) {
        Ok(url) => url,
        Err(reason) => return text_response(StatusCode::BAD_REQUEST, &entry_page(Some(&reason))),
    };

    match crate::settings::store(&app, &url) {
        Ok(()) => text_response(StatusCode::OK, &saved_page(&url)),
        Err(error) => {
            let reason = format!(
                "The URL is valid but could not be saved to disk: {error}. \
Check permissions on the app data folder, then restart Taskly."
            );
            text_response(StatusCode::INTERNAL_SERVER_ERROR, &entry_page(Some(&reason)))
        }
    }
}

/// Accepts bare hosts such as `taskly.example.com` by assuming `https://`;
/// full URLs pass through unchanged.
fn normalize_input(submitted: &str) -> Result<String, String> {
    let trimmed = submitted.trim();
    if trimmed.is_empty() {
        return Err("Paste the address of your Taskly web app first.".to_string());
    }
    if trimmed.contains("://") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("https://{trimmed}"))
    }
}

fn entry_page(problem: Option<&str>) -> String {
    let problem_html = match problem {
        Some(reason) => format!(
            "<p class=\"problem\" role=\"alert\">{}</p>",
            html_escape(reason)
        ),
        None => String::new(),
    };

    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Taskly — connect your server</title>
<style>
  body {{ margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #0b5345; color: #f3f7f6; }}
  main {{ min-height: 100vh; display: grid; place-content: center; padding: 2rem; box-sizing: border-box; }}
  .card {{ background: #103f37; border-radius: 14px; padding: 2rem 2.2rem; width: min(30rem, 92vw); }}
  h1 {{ margin: 0 0 0.6rem; font-size: 1.35rem; }}
  p {{ line-height: 1.55; }}
  label {{ display: block; margin: 1.1rem 0 0.4rem; font-weight: 600; }}
  input {{ width: 100%; box-sizing: border-box; padding: 0.7rem 0.8rem; border-radius: 8px;
           border: 1px solid #3d6c62; background: #0b5345; color: inherit; font-size: 1rem; }}
  button {{ margin-top: 1rem; padding: 0.7rem 1.4rem; border: 0; border-radius: 8px; font-size: 1rem;
            font-weight: 600; color: #3a2c00; background: #da9100; cursor: pointer; }}
  button:hover {{ filter: brightness(1.08); }}
  .problem {{ background: #5c1f1f; color: #ffd7d7; border-radius: 8px; padding: 0.6rem 0.8rem; }}
  .hint {{ color: #a7c4bd; font-size: 0.85rem; margin-bottom: 0; }}
</style>
</head>
<body>
<main>
  <div class="card">
    <h1>Welcome to Taskly</h1>
    <p>This app shows your Taskly web app in a desktop window. Paste the address of your Taskly
    server (the URL you normally open in the browser), then click <strong>Start Taskly</strong>.
    Sign-in happens inside the window, as on the web.</p>
    {problem_html}
    <form method="GET" action="/save">
      <label for="url">Taskly server URL</label>
      <input id="url" name="url" type="url" inputmode="url" placeholder="https://taskly.example.com" autocomplete="url" autofocus required>
      <button type="submit">Start Taskly</button>
    </form>
    <p class="hint">On this machine during development, http://localhost:3100 also works.</p>
  </div>
</main>
</body>
</html>"#
    )
}

/// Success page: the (already validated) URL is embedded into the meta
/// refresh, so the browser itself navigates the webview to the web app.
fn saved_page(url: &tauri::Url) -> String {
    let target = html_escape(&url.to_string());
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="1;url={target}">
<title>Taskly — starting…</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-content: center; gap: 0.5rem;
          background: #0b5345; color: #f3f7f6; font-family: "Segoe UI", system-ui, sans-serif; }}
  a {{ color: #9fd3c7; }}
</style>
</head>
<body>
<p>Saved. Opening your Taskly app…</p>
<p><a href="{target}">If nothing happens within a second, click here.</a></p>
</body>
</html>"#
    )
}

fn text_response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    match Response::builder()
        .status(status)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(body.as_bytes().to_vec())
    {
        Ok(response) => response,
        // The builder can only fail for malformed status/header input, which
        // the constants above exclude; keep a panic-free fallback anyway.
        Err(_) => Response::new(b"internal Taskly setup screen error".to_vec()),
    }
}

/// Minimal HTML escaping for text placed into attributes and paragraphs.
fn html_escape(raw: &str) -> String {
    raw.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// Extracts `url` from an application/x-www-form-urlencoded query string.
fn form_value(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (name, value) = match pair.split_once('=') {
            Some((name, value)) => (name, value),
            None => (pair, ""),
        };
        if percent_decode(name) == key {
            return Some(percent_decode(value));
        }
    }
    None
}

/// Decodes `%XX` sequences and `+` (form encoding). Invalid or truncated
/// escapes pass through unchanged instead of erroring — the URL is
/// re-validated afterwards regardless.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut decoded: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                decoded.push(b' ');
                index += 1;
            }
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok();
                match hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                    Some(value) => {
                        decoded.push(value);
                        index += 3;
                    }
                    None => {
                        decoded.push(b'%');
                        index += 1;
                    }
                }
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

#[cfg(test)]
mod tests {
    use super::{form_value, html_escape, normalize_input, percent_decode};

    #[test]
    fn form_value_decodes_the_url_parameter() {
        let query = "url=https%3A%2F%2Ftaskly.example.com%2Fconf%3Froom%3D1&extra=1";
        assert_eq!(
            form_value(query, "url").as_deref(),
            Some("https://taskly.example.com/conf?room=1")
        );
    }

    #[test]
    fn schemeless_input_becomes_https() {
        assert_eq!(
            normalize_input("taskly.example.com").unwrap(),
            "https://taskly.example.com"
        );
        assert_eq!(
            normalize_input("  http://localhost:3100  ").unwrap(),
            "http://localhost:3100"
        );
    }

    #[test]
    fn empty_input_gives_a_readable_error() {
        assert!(normalize_input("   ").is_err());
    }

    #[test]
    fn percent_decode_handles_plus_and_bad_escapes() {
        assert_eq!(percent_decode("a+b%20c"), "a b c");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
    }

    #[test]
    fn escape_blocks_breakouts() {
        assert_eq!(html_escape("\" onload=\""), "&#34; onload=&#34;");
    }
}
