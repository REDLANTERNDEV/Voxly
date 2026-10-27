//! Where each desktop window was left, so it reopens there.
//!
//! Home and each Installation keep their own placement, keyed by [`HOME`] or
//! the saved Installation id — never by window label, which changes every time
//! an Installation window opens. Only a window's last normal bounds and whether
//! it was maximized are kept; fullscreen is never restored, and with nothing
//! saved an Installation opens maximized while Home opens centred. This is
//! local window geometry: no command exposes it to any page (ADR-0019).

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Manager, WebviewWindow};

pub const HOME: &str = "home";

/// Physical pixels: outer position, inner size.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Bounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub bounds: Bounds,
    pub maximized: bool,
}

/// How much of a window's top edge must lie on a screen for it to be grabbed.
const REACHABLE_WIDTH: i64 = 64;
const TITLE_BAR: i64 = 32;

/// Where a saved placement reopens, given the screens' work areas with the
/// primary first. A window whose title bar would land on no screen — its
/// monitor was unplugged, say — is recentred on the primary, shrunk to fit.
pub fn restore(saved: Placement, screens: &[Bounds]) -> Placement {
    let Some(primary) = screens.first() else {
        return saved;
    };
    if screens
        .iter()
        .any(|screen| reachable(&saved.bounds, screen))
    {
        return saved;
    }
    let width = saved.bounds.width.min(primary.width);
    let height = saved.bounds.height.min(primary.height);
    Placement {
        bounds: Bounds {
            x: primary.x + ((primary.width - width) / 2) as i32,
            y: primary.y + ((primary.height - height) / 2) as i32,
            width,
            height,
        },
        maximized: saved.maximized,
    }
}

fn reachable(window: &Bounds, screen: &Bounds) -> bool {
    let (left, right) = (window.x as i64, window.x as i64 + window.width as i64);
    let (screen_left, screen_right) = (screen.x as i64, screen.x as i64 + screen.width as i64);
    let (top, screen_top) = (window.y as i64, screen.y as i64);
    right.min(screen_right) - left.max(screen_left) >= REACHABLE_WIDTH
        && top + TITLE_BAR > screen_top
        && top < screen_top + screen.height as i64 - TITLE_BAR
}

/// Every window's placement, written to disk a moment after it stops moving.
pub struct Placements {
    path: PathBuf,
    saved: Mutex<BTreeMap<String, Placement>>,
    changes: AtomicU64,
}

impl Placements {
    /// A missing or unreadable file only means windows open at their defaults.
    pub fn load(path: PathBuf) -> Self {
        let saved = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            saved: Mutex::new(saved),
            changes: AtomicU64::new(0),
        }
    }

    pub fn get(&self, key: &str) -> Option<Placement> {
        self.saved.lock().ok()?.get(key).copied()
    }

    /// Records where a window now is. A maximized window reports no bounds, so
    /// the normal bounds it will restore to are kept. Returns whether anything
    /// changed.
    pub fn record(&self, key: &str, bounds: Option<Bounds>, maximized: bool) -> bool {
        let Ok(mut saved) = self.saved.lock() else {
            return false;
        };
        let previous = saved.get(key).copied();
        let Some(bounds) = bounds.or(previous.map(|placement| placement.bounds)) else {
            return false;
        };
        let next = Placement { bounds, maximized };
        if previous == Some(next) {
            return false;
        }
        saved.insert(key.to_owned(), next);
        true
    }

    pub fn save(&self) -> Result<(), &'static str> {
        let bytes = {
            let saved = self.saved.lock().map_err(|_| "storage_failed")?;
            serde_json::to_vec_pretty(&*saved).map_err(|_| "storage_failed")?
        };
        let parent = self.path.parent().ok_or("storage_failed")?;
        std::fs::create_dir_all(parent).map_err(|_| "storage_failed")?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, bytes).map_err(|_| "storage_failed")?;
        std::fs::rename(temporary, &self.path).map_err(|_| "storage_failed")
    }
}

/// Puts a hidden window where it was left. Returns whether it was maximized,
/// or `None` when nothing is saved for it; maximizing waits for the caller to
/// reveal the window, since maximizing can show it early.
pub fn apply(window: &WebviewWindow, key: &str) -> Option<bool> {
    let saved = window.state::<Placements>().get(key)?;
    let placement = restore(saved, &screens(window));
    let bounds = placement.bounds;
    // Position first: arriving on a screen with another scale can resize it.
    let _ = window.set_position(tauri::PhysicalPosition::new(bounds.x, bounds.y));
    let _ = window.set_size(tauri::PhysicalSize::new(bounds.width, bounds.height));
    Some(placement.maximized)
}

/// Whether an Installation window should be maximized as it is revealed.
pub fn opens_maximized(app: &tauri::AppHandle, key: &str) -> bool {
    app.state::<Placements>()
        .get(key)
        .is_none_or(|placement| placement.maximized)
}

fn screens(window: &WebviewWindow) -> Vec<Bounds> {
    let primary = window.primary_monitor().ok().flatten();
    let mut monitors = window.available_monitors().unwrap_or_default();
    let is_primary = |monitor: &tauri::Monitor| {
        primary.as_ref().is_some_and(|primary| {
            primary.position() == monitor.position() && primary.size() == monitor.size()
        })
    };
    monitors.sort_by_key(|monitor| !is_primary(monitor));
    monitors
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Bounds {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect()
}

/// Follows a window's moves and resizes from now on.
pub fn track(window: &WebviewWindow, key: String) {
    let tracked = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => remember(&tracked, &key),
        tauri::WindowEvent::CloseRequested { .. } => {
            let _ = tracked.state::<Placements>().save();
        }
        _ => {}
    });
}

fn remember(window: &WebviewWindow, key: &str) {
    // Hidden windows are being placed by us; minimized and fullscreen ones are
    // not where the member wants them to reopen.
    if !window.is_visible().unwrap_or(false)
        || window.is_minimized().unwrap_or(true)
        || window.is_fullscreen().unwrap_or(true)
    {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let bounds = if maximized {
        None
    } else {
        let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) else {
            return;
        };
        Some(Bounds {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
        })
    };
    let placements = window.state::<Placements>();
    if !placements.record(key, bounds, maximized) {
        return;
    }
    let change = placements.changes.fetch_add(1, Ordering::AcqRel) + 1;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let placements = app.state::<Placements>();
        if placements.changes.load(Ordering::Acquire) == change {
            let _ = placements.save();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: Bounds = Bounds {
        x: 0,
        y: 0,
        width: 1920,
        height: 1040,
    };
    const RIGHT: Bounds = Bounds {
        x: 1920,
        y: 0,
        width: 2560,
        height: 1400,
    };

    fn at(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> Placement {
        Placement {
            bounds: Bounds {
                x,
                y,
                width,
                height,
            },
            maximized,
        }
    }

    #[test]
    fn a_window_reopens_exactly_where_it_was_left_on_any_screen() {
        let left = at(2200, 100, 1280, 800, false);
        assert_eq!(restore(left, &[PRIMARY, RIGHT]), left);
        let maximized = at(100, 80, 1280, 800, true);
        assert_eq!(restore(maximized, &[PRIMARY, RIGHT]), maximized);
    }

    #[test]
    fn a_window_left_on_an_unplugged_screen_is_recentred_on_the_primary_and_shrunk_to_fit() {
        let restored = restore(at(2200, 100, 2400, 1300, true), &[PRIMARY]);
        assert_eq!(restored, at(0, 0, 1920, 1040, true));
        let restored = restore(at(2200, 100, 1280, 800, false), &[PRIMARY]);
        assert_eq!(restored, at(320, 120, 1280, 800, false));
    }

    #[test]
    fn a_window_whose_title_bar_cannot_be_grabbed_is_recentred() {
        // Only a sliver on screen, or the title bar above or below every screen.
        for window in [
            at(1900, 100, 1280, 800, false),
            at(100, -200, 1280, 800, false),
            at(100, 1030, 1280, 800, false),
        ] {
            assert_eq!(restore(window, &[PRIMARY]), at(320, 120, 1280, 800, false));
        }
        // The few pixels a maximized frame hangs off the edge are still fine.
        let edge = at(-8, -8, 1280, 800, false);
        assert_eq!(restore(edge, &[PRIMARY]), edge);
    }

    #[test]
    fn with_no_screen_reported_the_saved_placement_is_trusted() {
        let saved = at(5000, 5000, 1280, 800, false);
        assert_eq!(restore(saved, &[]), saved);
    }

    #[test]
    fn maximizing_keeps_the_normal_bounds_it_will_restore_to() {
        let placements = Placements::load(std::env::temp_dir().join("voxly-placement-unused.json"));
        let normal = Bounds {
            x: 40,
            y: 60,
            width: 1100,
            height: 700,
        };
        assert!(
            !placements.record("first", None, true),
            "nothing to restore to yet"
        );
        assert!(placements.record("a", Some(normal), false));
        assert!(placements.record("a", None, true));
        assert_eq!(
            placements.get("a"),
            Some(Placement {
                bounds: normal,
                maximized: true
            })
        );
        assert!(
            !placements.record("a", None, true),
            "an unchanged report is not a change"
        );
        assert_eq!(
            placements.get("b"),
            None,
            "each window keeps its own placement"
        );
    }

    #[test]
    fn placements_survive_a_restart_and_a_corrupt_file_only_means_defaults() {
        let directory = std::env::temp_dir().join(format!(
            "voxly-window-placement-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("window-placements.json");
        let placements = Placements::load(path.clone());
        let normal = Bounds {
            x: 10,
            y: 20,
            width: 900,
            height: 600,
        };
        placements.record(HOME, Some(normal), false);
        placements.save().unwrap();
        assert_eq!(
            Placements::load(path.clone()).get(HOME),
            Some(Placement {
                bounds: normal,
                maximized: false
            })
        );
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(Placements::load(path).get(HOME), None);
        let _ = std::fs::remove_dir_all(directory);
    }
}
