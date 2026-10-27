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
mod system_activity;
mod update_card;
mod update_installer;
mod updates;
mod window_placement;

fn main() {
    // The staged update card never starts the shell, its plugins or single-instance.
    if let Some(request) = update_card::request(std::env::args_os()) {
        std::process::exit(update_card::run(request));
    }
    shell::run();
}
