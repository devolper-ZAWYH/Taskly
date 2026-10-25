// Prevents an extra console window from spawning alongside the app in
// release builds. Dev builds keep the console so logs are visible.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    taskly_shell::run()
}
