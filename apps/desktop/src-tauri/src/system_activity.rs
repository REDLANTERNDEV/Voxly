//! Machine-wide activity for the installation's idle presence.
//!
//! A browser sees input only inside its own window, so a member working in
//! another program looks exactly like one who walked away. Windows knows better:
//! it records the last input anywhere in the session, and whether the session is
//! locked. Each poll turns that into at most one fixed signal for the remote
//! window. No idle duration, timestamp, application or window crosses the
//! bridge; the installation learns only "someone is here" or "the machine was
//! locked", which is less than its own window already tells it.
//!
//! Sleep needs no signal of its own: a sleeping machine drops its socket, and
//! the server already reports a dropped member as offline.

// Only Windows samples; elsewhere the bridge is simply never called.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

use std::time::Duration;

/// Long enough to stay out of the way, short enough that a locked screen turns
/// the dot within a quarter of a minute.
pub const POLL_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Active,
    Away,
}

/// What the previous poll saw, so only a change is reported.
#[derive(Default)]
pub struct Tracker {
    last_input: Option<u32>,
    locked: bool,
}

impl Tracker {
    /// `last_input` is the session's last-input tick; it only matters whether
    /// it moved. The first sample establishes a baseline and says nothing.
    pub fn observe(&mut self, last_input: u32, locked: bool) -> Option<Signal> {
        let previous = self.last_input.replace(last_input);
        let was_locked = std::mem::replace(&mut self.locked, locked);
        if locked {
            return (!was_locked).then_some(Signal::Away);
        }
        (was_locked || previous.is_some_and(|previous| previous != last_input))
            .then_some(Signal::Active)
    }
}

/// Fixed script text: nothing the installation supplied is ever evaluated.
pub fn script(signal: Signal) -> &'static str {
    match signal {
        Signal::Active => "window.__VOXLY_DESKTOP_V1__?.dispatchSystemActivity?.(\"active\");",
        Signal::Away => "window.__VOXLY_DESKTOP_V1__?.dispatchSystemActivity?.(\"away\");",
    }
}

/// The session's last-input tick and whether its input desktop is the secure
/// one, which is what a locked workstation shows. `None` when Windows declines
/// to answer, which skips the poll rather than guessing.
#[cfg(target_os = "windows")]
pub fn sample() -> Option<(u32, bool)> {
    use windows_sys::Win32::System::StationsAndDesktops::{
        CloseDesktop, OpenInputDesktop, DESKTOP_SWITCHDESKTOP,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized, writable LASTINPUTINFO.
    if unsafe { GetLastInputInfo(&mut info) } == 0 {
        return None;
    }
    // SAFETY: a plain query; the handle is closed below when one is returned.
    let desktop = unsafe { OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP) };
    let locked = desktop.is_null();
    if !locked {
        // SAFETY: `desktop` is the handle OpenInputDesktop just returned.
        unsafe { CloseDesktop(desktop) };
    }
    Some((info.dwTime, locked))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_sample_is_only_a_baseline() {
        let mut tracker = Tracker::default();
        assert_eq!(tracker.observe(100, false), None);
        assert_eq!(tracker.observe(100, false), None);
    }

    #[test]
    fn reports_input_since_the_last_poll() {
        let mut tracker = Tracker::default();
        tracker.observe(100, false);
        assert_eq!(tracker.observe(250, false), Some(Signal::Active));
        assert_eq!(tracker.observe(250, false), None);
        // The tick wraps after 49.7 days; a change is a change.
        assert_eq!(tracker.observe(3, false), Some(Signal::Active));
    }

    #[test]
    fn reports_a_lock_once_and_the_unlock_as_activity() {
        let mut tracker = Tracker::default();
        tracker.observe(100, false);
        assert_eq!(tracker.observe(100, true), Some(Signal::Away));
        assert_eq!(
            tracker.observe(400, true),
            None,
            "input on the lock screen is not presence"
        );
        assert_eq!(tracker.observe(400, false), Some(Signal::Active));
    }

    #[test]
    fn a_session_that_starts_locked_is_away() {
        let mut tracker = Tracker::default();
        assert_eq!(tracker.observe(100, true), Some(Signal::Away));
    }

    #[test]
    fn scripts_are_fixed_and_carry_only_the_signal() {
        assert_eq!(
            script(Signal::Active),
            "window.__VOXLY_DESKTOP_V1__?.dispatchSystemActivity?.(\"active\");"
        );
        assert_eq!(
            script(Signal::Away),
            "window.__VOXLY_DESKTOP_V1__?.dispatchSystemActivity?.(\"away\");"
        );
    }
}
