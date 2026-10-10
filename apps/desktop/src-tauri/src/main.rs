#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod call_state;
mod deep_links;
mod input_bindings;
mod installations;
#[cfg(target_os = "windows")]
mod mouse_hook;
mod native_notifications;
mod platform;
mod shell;
mod shortcuts;
mod update_installer;
mod updates;

fn main() {
    shell::run();
}
