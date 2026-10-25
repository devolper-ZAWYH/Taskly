# Taskly desktop app (Tauri v2 shell) — Phase 4 prep scaffold

`desktop-app/` is the Tauri v2 wrapper around the **existing Taskly web UI**
plus the future home of the local capture engine (mic + system loopback →
whisper.cpp → push to `/api/live/push`, see `..\.opencode plan` /
`plan-live-meetings.md` §3).

**Status: scaffold only.** This machine has no Rust toolchain, so nothing was
compiled here — every decision below was chosen so `cargo tauri build` works
first try after installing the prerequisites.

---

## 1. Layout

```
desktop-app/
├── README.md                    ← this file
├── .gitignore                   ← target/, gen/, node_modules/, generated icons
├── www/
│   └── index.html               ← bundled fallback asset for tauri://localhost
│                                  (frontendDist); normally never seen
├── scripts/
│   └── make_placeholder_icon.py ← stdlib-only 1024×1024 PNG writer (done once)
└── src-tauri/
    ├── Cargo.toml               ← tauri 2 (+ tray-icon), serde, deep-link +
    │                              single-instance plugins (desktop-only target)
    ├── build.rs                 ← tauri_build::build() (compiles conf/capabilities/icons)
    ├── tauri.conf.json          ← identifier com.zawyh.taskly, v0.1.0, 1280×800 /
    │                              min 960×640, devUrl http://localhost:3100,
    │                              NSIS bundle, updater intentionally absent (OFF)
    ├── capabilities/
    │   └── default.json         ← core:default + core:window:allow-set-title
    │                              for window "main" ONLY; remote web app gets
    │                              zero IPC; no core:tray:*/core:menu:* (Rust-side tray)
    ├── icons/
    │   ├── ICONS.md             ← needed sizes + generation commands + TODO
    │   └── source/
    │       ├── taskly.svg       ← brand vector (copied from public/brand/ — reference)
    │       └── app-icon-1024.png← stdlib-generated placeholder (grey? no — brand-green/navy)
    └── src/
        ├── main.rs              ← thin entry (taskly_shell::run(); GUI subsystem in release)
        ├── lib.rs               ← builder wiring: plugins, setup screen protocol,
        │                          close-to-tray window event, tray, first window,
        │                          deep-link registration; log_line helper
        ├── settings.rs          ← minimal settings store: %APPDATA%\com.zawyh.taskly\
        │                          config.json (server_url; unknown keys preserved;
        │                          temp-file + rename writes; https-only validation,
        │                          http allowed for localhost) + unit tests
        ├── window.rs            ← startup-target logic (dev server / setup screen /
        │                          configured), window attrs, close-button = hide
        ├── tray.rs              ← tray icon + right-click menu + click/focus handling
        └── setup_screen.rs      ← local first-run URL screen served from the
                                   taskly-setup custom scheme (plain HTML; GET /save
                                   → validate+store → meta-refresh into the web app)
```

## 2. Runtime behaviour (v0)

| Situation | What the shell shows |
| --- | --- |
| Production, first run (config file missing/empty/invalid) | Local setup screen: paste Taskly URL → saved → webview navigates into your Taskly app |
| Production, configured | Your Taskly web app embedded (cookies sign-in, exactly as in the browser) |
| Dev (`cargo tauri dev`), no config | http://localhost:3100 (the existing web app's dev server) — setup screen skipped |
| Dev, config set | The configured URL wins (delete config.json to get back to the dev server) |
| Window close button | Hides to tray (app keeps running). Quit only via tray → "Quit". Left-click on tray shows/focuses the window; right click opens the menu |

Settings file: `C:\Users\<you>\AppData\Roaming\com.zawyh.taskly\config.json`
with e.g. `{"server_url": "https://taskly.example.com"}`. Default = empty
(hardcoded) → setup screen. Validation: `https://` required; `http://`
accepted only for localhost/127.0.0.1/[::1]. X non-https URLs are refused.

Deep links: `taskly://` is declared in `tauri.conf.json → plugins >
deep-link > desktop.schemes` and `register_all()` runs at startup on
Windows/Linux (HKCU), so even dev builds handle `taskly://...` clicks;
the URL is logged only — routing (OAuth redirect pairing) is a later
phase. A second launch while running focuses the existing window
(single-instance plugin, `deep-link` feature enabled).

---

## 3. Prerequisites (exact — none of these are installed yet)

1. **VS Build Tools 2022 with C++ workload** (MSVC compiler + Windows SDK):

   ```powershell
   winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
   ```

   (Or download *Visual Studio Build Tools* from visualstudio.microsoft.com and
   tick **Desktop development with C++**.)

2. **rustup + stable MSVC toolchain** (do NOT use the GNU toolchain for this):

   ```powershell
   winget install --id Rustlang.Rustup
   rustup default stable-msvc
   ```

   Note: the deep-link plugin needs a recent stable (docs say ≥ 1.90; any
   current stable is fine).

3. **Tauri CLI** (cargo subcommand — this is the variant the scaffold is
   documented against):

   ```powershell
   cargo install tauri-cli --version "^2"
   ```

   NSIS does **not** need to be installed by hand: `tauri-cli` downloads the
   NSIS toolchain (and Wix, if ever needed) into `%LOCALAPPDATA%\tauri` on
   first bundling. Node/npm is **not required** for the desktop app at all.

4. **A running Taskly web app on http://localhost:3100** for dev runs
   (`cargo tauri dev` only). Production installs load the URL the user
   entered instead.

## 4. Commands (copy-paste, in order)

```powershell
cd C:\Users\Thouseef Purayil\Desktop\Taskly\desktop-app

# one-time if not done yet (placeholder icon already exists in the tree):
# python scripts\make_placeholder_icon.py

# generate the runtime icon set from the placeholder (or the real render):
cargo tauri icon src-tauri\icons\source\app-icon-1024.png

# dev: needs the web dev server on 3100 in another terminal
cargo tauri dev

# production installer:
cargo tauri build
# → src-tauri\target\release\bundle\nsis\Taskly_0.1.0_x64-setup.exe
```

Installer facts: NSIS target configured (`bundle.targets = ["nsis"]`),
per-user install (`installMode = currentUser`, no elevation needed —
"installable by a normal user"), English UI, app icon from
`bundle.icon`. The `.exe` binary plus the installer both live under
`src-tauri/target/release/`.

Optional: `cargo tauri build --no-bundle` (run/test the bare exe), or add
`--debug` for a debug bundle.

## 5. Updater — OFF by design (TODO for signed releases)

Plan requires signed update manifests over HTTPS. Deliberately left out of
`tauri.conf.json` so an unsigned updater can never ship. When Phase 4
signing is ready, this is the exact block to add:

- [ ] `cargo add tauri-plugin-updater --source crates.io` and
      `tauri-plugin-process` (optional relaunch helper), register in
      `lib.rs` (`builder.plugin(tauri_plugin_updater::Builder::new().build())`).
- [ ] Generate keys once, store the private key + password in the signing
      environment (never in the repo):
      `cargo tauri signer generate -w ~/.tauri/taskly.key`
- [ ] `tauri.conf.json → bundle.createUpdaterArtifacts: true`
- [ ] `tauri.conf.json → plugins.updater`: `"active": true`,
      `"pubkey": "<minisign pubkey>"`,
      `"endpoints": ["https://<host>/updates/{{target}}/{{current_version}}"]`
      (GitHub Releases or the cPanel site — both are served over HTTPS).
- [ ] CI signing: `cargo tauri build` with
      `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD` env vars, then publish the
      `.msi`/`.exe` + `.sig` + `latest.json` manifest to the endpoint.
- [ ] Keep `bundle.targets: ["nsis"]`; decide on `msi` only if WiX signing
      is wanted as well.

## 6. What still needs to be done (checklists)

### Before the first real build (human)
- [ ] Install prerequisites (§3).
- [ ] `cargo tauri icon src-tauri\icons\source\app-icon-1024.png`
      (placeholder is valid but not final artwork — render the real
      `public/brand/taskly.svg` to a 1024×1024 PNG first if desired; see
      `src-tauri/icons/ICONS.md`).
- [ ] `cargo tauri dev` with the web app on localhost:3100 → login etc.
      should feel like the browser.
- [ ] `cargo tauri build` → install the exe → first-run URL screen →
      enter prod URL → app shows; tray: Open/Quit work, close hides to tray.

### Later phases (engine / Phase 4 proper)
- [ ] Wire "Start capture (soon)" / "Stop capture (soon)": enable the
      disabled menu items (`src-tauri/src/tray.rs`) and connect them to the
      engine's start/stop (menu events → engine API calls); add recording
      state tooltip to the tray icon when capturing.
- [ ] Engine settings pane (mic/system device picker, model picker) inside
      the shell window — new commands + capability additions as needed
      (replace `core:default` with the exact narrower core sets if desired).
- [ ] If/when the embedded web app itself needs Tauri APIs, add a capability
      entry with `remote: { urls: ["<exact app origin(s)>"] }` — never a
      blanket wildcard; today remote pages have zero IPC by design.
- [ ] Deep-link routing: `taskly://` payloads → OAuth redirect pairing.
- [ ] CSP: `app.security.csp` is `null` for v0; set a real policy once the
      shell owns more bespoke pages (the embedded remote app is governed by
      its own headers).
- [ ] Adopt `tauri-plugin-log` (file + webview sinks) — current logging is
      stderr only.
- [ ] Updater: see §5.

## 7. Notes / review pointers

- No RU unwraps in any request/event handler: handlers map errors to logs
  or readable fallback pages; the only `std::process::exit(1)` is on
  "cannot start at all". `url::Url::parse` of a compile-time constant is
  handled with an error path instead of unwrap.
- No destructive operations anywhere: close = hide; quit via tray;
  settings file writes are temp+rename (no truncation windows).
- `withGlobalTauri` is false; the embedded web page is plain remote content.
- Capabilities JSON parses as strict JSON (no comments) — verified with
  `node -e "JSON.parse(...)"` at scaffold time.
- `tauri://localhost` in dev proxies to `build.devUrl` (3100); in production
  it serves `www/`, which is why that folder exists even though it is
  normally never shown.
