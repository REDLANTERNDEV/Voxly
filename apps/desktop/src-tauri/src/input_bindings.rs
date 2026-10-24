//! Physical-key matching for the Windows observer. Never consumes OS input.
#[cfg(any(test, target_os = "windows"))]
use crate::shortcuts::Action;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PhysicalBinding {
    pub key: u16,
    // 0 = absent, 1 = left, 2 = right, 3 = both, 4 = either (legacy).
    pub modifiers: [u8; 4],
}

const MODIFIER_KEYS: [[u16; 2]; 4] = [[0x1d, 0x11d], [0x38, 0x138], [0x2a, 0x36], [0x15b, 0x15c]];

pub fn key_code(code: &str) -> Option<u16> {
    let key = match code {
        "Space" => 0x39,
        "Enter" => 0x1c,
        "Backspace" => 0x0e,
        "Delete" => 0x153,
        "Insert" => 0x152,
        "Home" => 0x147,
        "End" => 0x14f,
        "PageUp" => 0x149,
        "PageDown" => 0x151,
        "ArrowUp" => 0x148,
        "ArrowDown" => 0x150,
        "ArrowLeft" => 0x14b,
        "ArrowRight" => 0x14d,
        "Backquote" => 0x29,
        "Minus" => 0x0c,
        "Equal" => 0x0d,
        "BracketLeft" => 0x1a,
        "BracketRight" => 0x1b,
        "Backslash" => 0x2b,
        "IntlBackslash" => 0x56,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "Numpad0" => 0x52,
        "Numpad1" => 0x4f,
        "Numpad2" => 0x50,
        "Numpad3" => 0x51,
        "Numpad4" => 0x4b,
        "Numpad5" => 0x4c,
        "Numpad6" => 0x4d,
        "Numpad7" => 0x47,
        "Numpad8" => 0x48,
        "Numpad9" => 0x49,
        "NumpadDecimal" => 0x53,
        "NumpadAdd" => 0x4e,
        "NumpadSubtract" => 0x4a,
        "NumpadMultiply" => 0x37,
        "NumpadDivide" => 0x135,
        "NumpadEnter" => 0x11c,
        "Mouse3" => 0x203,
        "Mouse4" => 0x204,
        "Mouse5" => 0x205,
        _ => {
            if let Some(letter) = code.strip_prefix("Key") {
                let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
                let scans = [
                    0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
                    0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
                ];
                if letter.len() == 1 {
                    return letters.find(letter).map(|index| scans[index]);
                }
            }
            if let Some(digit) = code.strip_prefix("Digit") {
                if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() {
                    let value = digit.as_bytes()[0] - b'0';
                    return Some(if value == 0 {
                        0x0b
                    } else {
                        u16::from(value) + 1
                    });
                }
            }
            if let Some(function) = code
                .strip_prefix('F')
                .and_then(|value| value.parse::<u16>().ok())
            {
                if (1..=24).contains(&function) && code == format!("F{function}") {
                    return Some(0x300 + 0x6f + function);
                }
            }
            return None;
        }
    };
    Some(key)
}

fn modifier(code: &str) -> Option<(usize, u8)> {
    Some(match code {
        "Control" => (0, 4),
        "ControlLeft" => (0, 1),
        "ControlRight" => (0, 2),
        "Alt" => (1, 4),
        "AltLeft" => (1, 1),
        "AltRight" => (1, 2),
        "Shift" => (2, 4),
        "ShiftLeft" => (2, 1),
        "ShiftRight" => (2, 2),
        "Super" => (3, 4),
        "MetaLeft" => (3, 1),
        "MetaRight" => (3, 2),
        _ => return None,
    })
}

pub fn parse_physical(binding: &str) -> Result<PhysicalBinding, &'static str> {
    if binding.len() > 160 || !binding.is_ascii() {
        return Err("shortcut_invalid");
    }
    let parts: Vec<_> = binding.split('+').collect();
    let standalone = parts.len() == 1 && modifier(parts[0]).is_some();
    let key = if standalone {
        0
    } else {
        key_code(parts.last().copied().unwrap_or_default()).ok_or("shortcut_invalid")?
    };
    let mut modifiers = [0; 4];
    let mut previous = None;
    for part in &parts[..parts.len() - usize::from(!standalone)] {
        let (group, side) = modifier(part).ok_or("shortcut_invalid")?;
        if previous.is_some_and(|(old_group, old_side)| {
            group < old_group || (group == old_group && (old_side != 1 || side != 2))
        }) {
            return Err("shortcut_invalid");
        }
        modifiers[group] |= side;
        previous = Some((group, side));
    }
    // Secure attention and OS window-management combinations cannot be voice bindings.
    if modifiers[3] != 0 && key != 0 && key < 0x200
        || (modifiers[0] != 0 && modifiers[1] != 0 && key == 0x153)
        || (modifiers[1] != 0 && key == 0x373)
    {
        return Err("shortcut_unavailable");
    }
    Ok(PhysicalBinding { key, modifiers })
}

#[cfg(any(test, target_os = "windows"))]
fn accepts(required: u8, actual: u8) -> bool {
    match required {
        0 => actual == 0,
        4 => actual != 0,
        _ => actual & required == required,
    }
}

pub fn overlaps(a: PhysicalBinding, b: PhysicalBinding) -> bool {
    a.key == b.key
        && a.modifiers.iter().zip(b.modifiers).all(|(&first, second)| {
            first == second
                || (first != 0 && second != 0 && (first == 4 || second == 4 || first & second != 0))
        })
}

#[cfg(any(test, target_os = "windows"))]
#[derive(Default)]
pub struct PhysicalShortcutGates {
    bindings: Vec<(Action, PhysicalBinding, bool)>,
    down: std::collections::HashSet<u16>,
}
#[cfg(any(test, target_os = "windows"))]
impl PhysicalShortcutGates {
    pub fn set(
        &mut self,
        action: Action,
        binding: Option<PhysicalBinding>,
    ) -> Option<(Action, bool)> {
        let release = self
            .bindings
            .iter()
            .find(|(old, _, held)| *old == action && *held)
            .map(|_| (action, false));
        self.bindings.retain(|(old, _, _)| *old != action);
        if let Some(binding) = binding {
            self.bindings.push((action, binding, false));
        }
        release
    }
    pub fn handle(&mut self, key: u16, pressed: bool) -> Vec<(Action, bool)> {
        let changed = if pressed {
            self.down.insert(key)
        } else {
            self.down.remove(&key)
        };
        if !changed {
            return Vec::new();
        }
        let modifiers: [u8; 4] = MODIFIER_KEYS.map(|keys| {
            u8::from(self.down.contains(&keys[0])) | (u8::from(self.down.contains(&keys[1])) << 1)
        });
        let mut events = Vec::new();
        for (action, binding, held) in &mut self.bindings {
            let matches = binding
                .modifiers
                .iter()
                .zip(modifiers)
                .all(|(&required, actual)| {
                    if binding.key == 0 && required == 0 {
                        true
                    } else {
                        accepts(required, actual)
                    }
                })
                && (binding.key == 0 || self.down.contains(&binding.key));
            let activating = if binding.key == 0 {
                MODIFIER_KEYS
                    .iter()
                    .enumerate()
                    .any(|(group, keys)| binding.modifiers[group] != 0 && keys.contains(&key))
            } else {
                binding.key == key
            };
            if *held && !matches {
                *held = false;
                events.push((*action, false));
            } else if !*held && matches && pressed && activating {
                *held = true;
                events.push((*action, true));
            }
        }
        events
    }
    pub fn release_all(&mut self) -> Vec<(Action, bool)> {
        self.down.clear();
        self.bindings
            .iter_mut()
            .filter_map(|(action, _, held)| {
                let release = *held;
                *held = false;
                release.then_some((*action, false))
            })
            .collect()
    }
}

/// Whether `binding` names exactly the keys in `chord` — no key the person did
/// not press, and none they pressed left out. A side-neutral modifier is
/// satisfied by either side. This is how a remote Installation's requested
/// binding is held to what the native hook saw (ADR-0020).
pub fn matches_observed(
    binding: &PhysicalBinding,
    chord: &std::collections::BTreeSet<u16>,
) -> bool {
    if chord.is_empty() || (binding.key != 0 && !chord.contains(&binding.key)) {
        return false;
    }
    let sides_present = MODIFIER_KEYS
        .iter()
        .zip(binding.modifiers)
        .all(|(keys, required)| {
            let left = chord.contains(&keys[0]);
            let right = chord.contains(&keys[1]);
            match required {
                0 => !left && !right,
                1 => left && !right,
                2 => right && !left,
                3 => left && right,
                _ => left || right,
            }
        });
    let nothing_else = chord
        .iter()
        .all(|code| *code == binding.key || MODIFIER_KEYS.iter().any(|keys| keys.contains(code)));
    sides_present && nothing_else
}

/// The last chord pressed while a remote Installation records a shortcut: the
/// keys held together since everything was last released. Fed by the native
/// hook from real, non-injected input; a fresh press after a full release
/// starts a new chord, so a fumbled attempt does not linger in it.
#[cfg(any(test, target_os = "windows"))]
#[derive(Default)]
pub struct ShortcutCapture {
    held: std::collections::BTreeSet<u16>,
    chord: std::collections::BTreeSet<u16>,
}

#[cfg(any(test, target_os = "windows"))]
impl ShortcutCapture {
    pub fn observe(&mut self, key: u16, pressed: bool) {
        if pressed {
            if self.held.is_empty() {
                self.chord.clear();
            }
            self.held.insert(key);
            self.chord.insert(key);
        } else {
            self.held.remove(&key);
        }
    }

    pub fn chord(&self) -> &std::collections::BTreeSet<u16> {
        &self.chord
    }
}

/// Function keys use their stable VK; other keys use scan code + extended bit.
#[cfg(any(test, target_os = "windows"))]
pub fn observed_key(scan: u32, extended: bool, virtual_key: u32) -> u16 {
    if (0x70..=0x87).contains(&virtual_key) {
        return 0x300 + virtual_key as u16;
    }
    scan as u16 | if extended { 0x100 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_sides_chords_repeats_and_release() {
        let mut gates = PhysicalShortcutGates::default();
        gates.set(
            Action::PushToTalk,
            Some(parse_physical("ControlRight").unwrap()),
        );
        assert!(gates.handle(0x1d, true).is_empty());
        assert_eq!(gates.handle(0x11d, true), vec![(Action::PushToTalk, true)]);
        assert!(gates.handle(0x11d, true).is_empty());
        assert!(gates.handle(0x1d, false).is_empty());
        assert_eq!(
            gates.handle(0x11d, false),
            vec![(Action::PushToTalk, false)]
        );
        gates.set(
            Action::Mute,
            Some(parse_physical("ControlRight+KeyM").unwrap()),
        );
        gates.handle(0x1d, true);
        assert!(gates.handle(0x32, true).is_empty());
        gates.handle(0x32, false);
        gates.handle(0x1d, false);
        gates.handle(0x11d, true);
        assert_eq!(gates.handle(0x32, true), vec![(Action::Mute, true)]);
        assert_eq!(
            gates.handle(0x11d, false),
            vec![(Action::PushToTalk, false), (Action::Mute, false)]
        );
        assert!(gates
            .handle(0x11d, true)
            .iter()
            .all(|(action, _)| *action != Action::Mute));
        assert_eq!(
            gates.set(Action::PushToTalk, None),
            Some((Action::PushToTalk, false))
        );
    }
    #[test]
    fn legacy_overlap_and_numpad_are_distinct() {
        assert!(overlaps(
            parse_physical("Control").unwrap(),
            parse_physical("ControlRight").unwrap()
        ));
        assert!(overlaps(
            parse_physical("Control+KeyM").unwrap(),
            parse_physical("ControlRight+KeyM").unwrap()
        ));
        assert!(!overlaps(
            parse_physical("ControlLeft+KeyM").unwrap(),
            parse_physical("ControlRight+KeyM").unwrap()
        ));
        for (code, scan, extended, vk) in [
            ("Enter", 0x1c, false, 13),
            ("NumpadEnter", 0x1c, true, 13),
            ("Numpad1", 0x4f, false, 35),
            ("End", 0x4f, true, 35),
        ] {
            assert_eq!(key_code(code), Some(observed_key(scan, extended, vk)));
        }
        assert_ne!(key_code("Digit1"), key_code("Numpad1"));
        assert_eq!(key_code("F24"), Some(observed_key(0, true, 0x87)));
    }
    #[test]
    fn plain_keys_and_cleanup() {
        let mut gates = PhysicalShortcutGates::default();
        gates.set(Action::PushToMute, Some(parse_physical("Space").unwrap()));
        assert_eq!(gates.handle(0x39, true), vec![(Action::PushToMute, true)]);
        assert_eq!(gates.release_all(), vec![(Action::PushToMute, false)]);
        assert!(gates.handle(0x39, false).is_empty());
        for code in [
            "KeyM",
            "ShiftLeft+KeyM",
            "ControlRight+Enter",
            "NumpadDivide",
            "Semicolon",
            "MetaRight",
        ] {
            assert!(parse_physical(code).is_ok(), "{code}");
        }
        for code in [
            "Escape",
            "Tab",
            "F25",
            "Control+Control+KeyM",
            "Alt+Control+KeyM",
        ] {
            assert!(parse_physical(code).is_err(), "{code}");
        }
        assert_eq!(parse_physical("Alt+F4"), Err("shortcut_unavailable"));
        assert_eq!(
            parse_physical("MetaRight+KeyM"),
            Err("shortcut_unavailable")
        );
        assert_eq!(
            parse_physical("Control+Alt+Delete"),
            Err("shortcut_unavailable")
        );
    }

    #[test]
    fn capture_keeps_only_the_last_chord_the_person_pressed() {
        let mut capture = ShortcutCapture::default();
        // A fumbled first attempt, fully released, then Ctrl+Shift+M.
        capture.observe(0x25, true);
        capture.observe(0x25, false);
        for key in [0x1d, 0x2a, 0x32] {
            capture.observe(key, true);
        }
        for key in [0x32, 0x2a, 0x1d] {
            capture.observe(key, false);
        }
        assert_eq!(capture.chord(), &[0x1d, 0x2a, 0x32].into_iter().collect());
        // A repeat of a held key is not a new chord.
        capture.observe(0x1d, true);
        capture.observe(0x1d, true);
        capture.observe(0x1d, false);
        assert_eq!(capture.chord(), &[0x1d].into_iter().collect());
    }

    #[test]
    fn a_binding_must_be_exactly_the_keys_that_were_pressed() {
        let chord = |keys: &[u16]| {
            keys.iter()
                .copied()
                .collect::<std::collections::BTreeSet<u16>>()
        };
        let binding = |text: &str| parse_physical(text).unwrap();
        assert!(matches_observed(
            &binding("ControlLeft+ShiftLeft+KeyM"),
            &chord(&[0x1d, 0x2a, 0x32])
        ));
        // Side-neutral modifiers accept either side.
        assert!(matches_observed(
            &binding("Control+KeyM"),
            &chord(&[0x11d, 0x32])
        ));
        assert!(matches_observed(&binding("ControlLeft"), &chord(&[0x1d])));
        assert!(matches_observed(
            &binding("Alt+Mouse4"),
            &chord(&[0x138, 0x204])
        ));
        // A key the page named but nobody pressed, or one pressed but left out.
        assert!(!matches_observed(&binding("KeyM"), &chord(&[0x1d, 0x32])));
        assert!(!matches_observed(
            &binding("ControlLeft+KeyM"),
            &chord(&[0x32])
        ));
        assert!(!matches_observed(
            &binding("ControlRight+KeyM"),
            &chord(&[0x1d, 0x32])
        ));
        assert!(!matches_observed(&binding("KeyA"), &chord(&[])));
    }
}
