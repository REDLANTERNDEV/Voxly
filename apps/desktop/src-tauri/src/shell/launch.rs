//! The launch card: checked for, downloaded and installed before Home opens.
use super::update_commands::install_at_launch;
use crate::{update_card, updates};
use std::time::Duration;
use tauri::Manager;

/// An offline or slow manifest never holds Home back for long.
const CHECK: Duration = Duration::from_secs(3);
/// A slower download carries on in the background and becomes "Update ready".
const DOWNLOAD: Duration = Duration::from_secs(90);
const PROGRESS: Duration = Duration::from_millis(100);

pub(super) async fn run(app: &tauri::AppHandle, card: update_card::LaunchCard) {
    if update_found(app).await && downloaded(app, &card).await {
        card.send(update_card::INSTALL_LINE);
        if install_at_launch(app).await {
            card.close();
            app.exit(0);
            return;
        }
    }
    card.close();
    let shell = app.clone();
    let _ = app.run_on_main_thread(move || {
        // Setup fails the same way when Home cannot be built. Exiting leaves
        // Voxly startable again, where carrying on would leave only a tray icon.
        if super::runtime::open_shell(&shell).is_err() {
            shell.exit(1);
        }
    });
}

async fn update_found(app: &tauri::AppHandle) -> bool {
    let task = app.clone();
    // A check that outlives the card still completes and publishes in the background.
    let check = tauri::async_runtime::spawn(async move {
        let updates = task.state::<updates::Updates>();
        updates
            .check(&task, updates::Trigger::Scheduled)
            .await
            .is_ok()
            && updates.background_download_allowed()
    });
    matches!(tokio::time::timeout(CHECK, check).await, Ok(Ok(true)))
}

async fn downloaded(app: &tauri::AppHandle, card: &update_card::LaunchCard) -> bool {
    let updates = app.state::<updates::Updates>();
    let version = updates.snapshot().version.unwrap_or_default();
    card.send(&update_card::download_line(&version));
    let task = app.clone();
    let download = tauri::async_runtime::spawn(async move {
        let updates = task.state::<updates::Updates>();
        updates
            .download(&task, updates::Trigger::Scheduled)
            .await
            .is_ok_and(|snapshot| snapshot.phase == "ready")
    });
    tokio::pin!(download);
    let deadline = tokio::time::Instant::now() + DOWNLOAD;
    let mut tick = tokio::time::interval(PROGRESS);
    loop {
        tokio::select! {
            result = &mut download => return matches!(result, Ok(true)),
            _ = tick.tick() => {
                if tokio::time::Instant::now() >= deadline {
                    return false;
                }
                let snapshot = updates.snapshot();
                card.send(&update_card::progress_line(snapshot.downloaded, snapshot.total));
            }
        }
    }
}
