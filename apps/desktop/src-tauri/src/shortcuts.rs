use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

#[cfg(any(test, target_os = "windows"))]
pub const CONTROL: u8 = 1;
#[cfg(any(test, target_os = "windows"))]
pub const ALT: u8 = 2;
#[cfg(any(test, target_os = "windows"))]
pub const SHIFT: u8 = 4;
#[cfg(any(test, target_os = "windows"))]
pub const SUPER: u8 = 8;

#[derive(Default)]
pub struct ShortcutLatch {
    pressed: AtomicBool,
}

impl ShortcutLatch {
    pub fn reset(&self) {
        self.pressed.store(false, Ordering::Release);
    }

    pub fn begin(&self) -> bool {
        !self.pressed.swap(true, Ordering::AcqRel)
    }

    pub fn keyboard_released(&self) {
        self.pressed.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseBinding {
    pub button: u8,
    pub modifiers: u8,
}

#[cfg(any(test, target_os = "windows"))]
#[derive(Default, Debug, PartialEq)]
pub struct MouseDecision {
    pub dispatch: bool,
    pub suppress: bool,
}

#[cfg(any(test, target_os = "windows"))]
pub struct MouseShortcutGate {
    binding: MouseBinding,
    held: bool,
    suppressed: bool,
}

#[cfg(any(test, target_os = "windows"))]
impl MouseShortcutGate {
    pub fn new(binding: MouseBinding) -> Self {
        Self {
            binding,
            held: false,
            suppressed: false,
        }
    }

    pub fn handle(
        &mut self,
        button: u8,
        modifiers: u8,
        pressed: bool,
        installation_focused: bool,
    ) -> MouseDecision {
        if button != self.binding.button {
            return MouseDecision::default();
        }
        if !pressed {
            if !self.held {
                return MouseDecision::default();
            }
            self.held = false;
            let suppress = self.suppressed;
            self.suppressed = false;
            return MouseDecision {
                dispatch: false,
                suppress,
            };
        }
        if self.held {
            return MouseDecision {
                dispatch: false,
                suppress: self.suppressed,
            };
        }
        if modifiers != self.binding.modifiers {
            return MouseDecision::default();
        }
        self.held = true;
        self.suppressed = installation_focused;
        MouseDecision {
            dispatch: true,
            suppress: self.suppressed,
        }
    }
}

pub enum Binding {
    Keyboard(Shortcut),
    Mouse(MouseBinding),
}

pub fn parse_binding(binding: &str) -> Result<Binding, &'static str> {
    if binding.len() > 80 || !binding.is_ascii() {
        return Err("shortcut_invalid");
    }
    let parts: Vec<_> = binding.split('+').collect();
    let key = parts.last().copied().unwrap_or_default();
    let letter = key.len() == 4 && key.starts_with("Key") && key.as_bytes()[3].is_ascii_uppercase();
    let digit = key.len() == 6 && key.starts_with("Digit") && key.as_bytes()[5].is_ascii_digit();
    let function = key
        .strip_prefix('F')
        .and_then(|value| value.parse::<u8>().ok())
        .is_some_and(|number| (1..=24).contains(&number) && key == format!("F{number}"));
    let mouse = matches!(key, "Mouse3" | "Mouse4" | "Mouse5");
    if !(letter || digit || function || mouse) || (parts.len() == 1 && !function && !mouse) {
        return Err("shortcut_invalid");
    }
    let modifiers = ["Control", "Alt", "Shift", "Super"];
    let mut previous = None;
    let mut modifier_mask = 0;
    for part in &parts[..parts.len() - 1] {
        let index = modifiers
            .iter()
            .position(|modifier| modifier == part)
            .ok_or("shortcut_invalid")?;
        if previous.is_some_and(|old| old >= index) {
            return Err("shortcut_invalid");
        }
        previous = Some(index);
        modifier_mask |= 1 << index;
    }
    // Shift alone is ordinary typing, even though the OS accepts it as a hotkey.
    if !function
        && !mouse
        && !parts
            .iter()
            .any(|part| matches!(*part, "Control" | "Alt" | "Super"))
    {
        return Err("shortcut_invalid");
    }
    if mouse {
        return Ok(Binding::Mouse(MouseBinding {
            button: match key {
                "Mouse3" => 3,
                "Mouse4" => 4,
                _ => 5,
            },
            modifiers: modifier_mask,
        }));
    }
    Shortcut::from_str(binding)
        .map(Binding::Keyboard)
        .map_err(|_| "shortcut_invalid")
}

pub trait Registry {
    fn register(&mut self, binding: &str) -> Result<(), &'static str>;
    fn clear(&mut self) -> Result<(), &'static str>;
}

pub struct NativeRegistry<'a>(pub &'a tauri::AppHandle);
impl Registry for NativeRegistry<'_> {
    fn register(&mut self, binding: &str) -> Result<(), &'static str> {
        match parse_binding(binding)? {
            Binding::Keyboard(shortcut) => self
                .0
                .global_shortcut()
                .register(shortcut)
                .map_err(|_| "shortcut_unavailable"),
            Binding::Mouse(mouse) => {
                #[cfg(target_os = "windows")]
                {
                    crate::mouse_hook::register(self.0, mouse)
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let _ = mouse;
                    Err("shortcut_unavailable")
                }
            }
        }
    }
    fn clear(&mut self) -> Result<(), &'static str> {
        self.0
            .global_shortcut()
            .unregister_all()
            .map_err(|_| "shortcut_failed")?;
        #[cfg(target_os = "windows")]
        crate::mouse_hook::clear()?;
        Ok(())
    }
}

#[derive(Clone, Default)]
pub struct Registration {
    pub active: Option<String>,
    pub error: Option<&'static str>,
}

impl Registration {
    pub fn restore(&mut self, binding: Option<&str>, registry: &mut impl Registry) {
        self.active = None;
        self.error = None;
        if let Some(binding) = binding {
            match registry.register(binding) {
                Ok(()) => self.active = Some(binding.into()),
                Err(error) => self.error = Some(error),
            }
        }
    }

    pub fn change(
        &mut self,
        binding: Option<&str>,
        registry: &mut impl Registry,
        save: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), &'static str> {
        if let Some(binding) = binding {
            parse_binding(binding)?;
        }
        if self.active.as_deref() == binding {
            save()?;
            self.error = None;
            return Ok(());
        }
        let previous = self.active.clone();
        registry.clear()?;
        self.active = None;
        let result = match binding {
            Some(binding) => registry.register(binding),
            None => Ok(()),
        }
        .and_then(|()| save());
        if let Err(error) = result {
            // If persistence fails, remove the new binding before restoring the old.
            if registry.clear().is_err() {
                self.active = binding.map(String::from);
                self.error = Some("shortcut_failed");
            } else {
                self.restore(previous.as_deref(), registry);
                if self.error.is_none() {
                    self.error = Some(error);
                }
            }
            return Err(error);
        }
        self.active = binding.map(String::from);
        self.error = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mouse_press_cycles_dispatch_once_and_only_block_installation_navigation() {
        let mut plain = MouseShortcutGate::new(MouseBinding {
            button: 5,
            modifiers: 0,
        });
        for _ in 0..20 {
            assert_eq!(
                plain.handle(5, 0, true, true),
                MouseDecision {
                    dispatch: true,
                    suppress: true
                }
            );
            assert_eq!(
                plain.handle(5, 0, false, true),
                MouseDecision {
                    dispatch: false,
                    suppress: true
                }
            );
        }

        let mut gate = MouseShortcutGate::new(MouseBinding {
            button: 5,
            modifiers: CONTROL,
        });
        let ignored = MouseDecision::default();
        assert_eq!(gate.handle(5, 0, true, true), ignored);
        assert_eq!(gate.handle(5, 0, false, true), ignored);
        for _ in 0..20 {
            assert_eq!(
                gate.handle(5, CONTROL, true, true),
                MouseDecision {
                    dispatch: true,
                    suppress: true
                }
            );
            assert_eq!(
                gate.handle(5, CONTROL, true, true),
                MouseDecision {
                    dispatch: false,
                    suppress: true
                }
            );
            assert_eq!(gate.handle(4, CONTROL, false, true), ignored);
            assert_eq!(
                gate.handle(5, 0, false, false),
                MouseDecision {
                    dispatch: false,
                    suppress: true
                }
            );
        }
        assert_eq!(
            gate.handle(5, CONTROL, true, false),
            MouseDecision {
                dispatch: true,
                suppress: false
            }
        );
        assert_eq!(gate.handle(5, 0, false, false), ignored);
    }

    #[derive(Default)]
    struct FakeRegistry {
        active: Option<String>,
        conflict: Option<String>,
    }
    impl Registry for FakeRegistry {
        fn register(&mut self, binding: &str) -> Result<(), &'static str> {
            if self.conflict.as_deref() == Some(binding) {
                return Err("shortcut_unavailable");
            }
            self.active = Some(binding.into());
            Ok(())
        }
        fn clear(&mut self) -> Result<(), &'static str> {
            self.active = None;
            Ok(())
        }
    }
    #[test]
    fn binding_policy_requires_explicit_physical_keys_and_safe_modifiers() {
        for binding in [
            "Control+Shift+KeyM",
            "Alt+Digit9",
            "F8",
            "Control+Alt+Shift+Super+F24",
            "Mouse4",
            "Mouse3",
            "Control+Shift+Mouse5",
        ] {
            assert!(parse_binding(binding).is_ok(), "{binding}");
        }
        for binding in [
            "KeyM",
            "Shift+KeyM",
            "Control",
            "Control+Control+KeyM",
            "Alt+Control+KeyM",
            "Control+Enter",
            "F25",
            "F01",
            "Alt+é",
            "Control+KeyMM",
            "Mouse1",
            "Mouse6",
            "Shift+Mouse4+KeyM",
        ] {
            assert!(parse_binding(binding).is_err(), "{binding}");
        }
        assert_eq!(
            match parse_binding("Control+Shift+Mouse5").unwrap() {
                Binding::Mouse(mouse) => mouse,
                Binding::Keyboard(_) => panic!("expected mouse binding"),
            },
            MouseBinding {
                button: 5,
                modifiers: CONTROL | SHIFT
            }
        );
        assert_eq!(
            match parse_binding("Control+Alt+Shift+Super+Mouse5").unwrap() {
                Binding::Mouse(mouse) => mouse.modifiers,
                Binding::Keyboard(_) => panic!("expected mouse binding"),
            },
            CONTROL | ALT | SHIFT | SUPER
        );
    }
    #[test]
    fn conflicts_and_storage_failure_restore_the_old_binding() {
        let mut registry = FakeRegistry::default();
        let mut registration = Registration::default();
        registration
            .change(Some("Control+KeyM"), &mut registry, || Ok(()))
            .unwrap();
        registry.conflict = Some("Control+KeyN".into());
        assert_eq!(
            registration.change(Some("Control+KeyN"), &mut registry, || panic!(
                "conflict must not save"
            )),
            Err("shortcut_unavailable")
        );
        assert_eq!(registry.active.as_deref(), Some("Control+KeyM"));
        assert_eq!(registration.active, registry.active);
        assert_eq!(
            registration.change(Some("Alt+KeyM"), &mut registry, || Err("storage_failed")),
            Err("storage_failed")
        );
        assert_eq!(registry.active.as_deref(), Some("Control+KeyM"));
        registration.change(None, &mut registry, || Ok(())).unwrap();
        assert!(registration.active.is_none() && registry.active.is_none());
    }
    #[test]
    fn failed_startup_registration_keeps_the_app_recoverable() {
        let mut registry = FakeRegistry {
            active: None,
            conflict: Some("F8".into()),
        };
        let mut registration = Registration::default();
        registration.restore(Some("F8"), &mut registry);
        assert!(registration.active.is_none());
        assert_eq!(registration.error, Some("shortcut_unavailable"));
        registration
            .change(Some("F9"), &mut registry, || Ok(()))
            .unwrap();
        assert_eq!(registration.active.as_deref(), Some("F9"));
        assert!(registration.error.is_none());
    }
}
