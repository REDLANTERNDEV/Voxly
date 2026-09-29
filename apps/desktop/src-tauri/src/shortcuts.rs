use std::str::FromStr;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub fn parse_binding(binding: &str) -> Result<Shortcut, &'static str> {
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
    if !(letter || digit || function) || (parts.len() == 1 && !function) {
        return Err("shortcut_invalid");
    }
    let modifiers = ["Control", "Alt", "Shift", "Super"];
    let mut previous = None;
    for part in &parts[..parts.len() - 1] {
        let index = modifiers
            .iter()
            .position(|modifier| modifier == part)
            .ok_or("shortcut_invalid")?;
        if previous.is_some_and(|old| old >= index) {
            return Err("shortcut_invalid");
        }
        previous = Some(index);
    }
    // Shift alone is ordinary typing, even though the OS accepts it as a hotkey.
    if !function
        && !parts
            .iter()
            .any(|part| matches!(*part, "Control" | "Alt" | "Super"))
    {
        return Err("shortcut_invalid");
    }
    Shortcut::from_str(binding).map_err(|_| "shortcut_invalid")
}

pub trait Registry {
    fn register(&mut self, binding: &str) -> Result<(), &'static str>;
    fn clear(&mut self) -> Result<(), &'static str>;
}

pub struct NativeRegistry<'a>(pub &'a tauri::AppHandle);
impl Registry for NativeRegistry<'_> {
    fn register(&mut self, binding: &str) -> Result<(), &'static str> {
        self.0
            .global_shortcut()
            .register(parse_binding(binding)?)
            .map_err(|_| "shortcut_unavailable")
    }
    fn clear(&mut self) -> Result<(), &'static str> {
        self.0
            .global_shortcut()
            .unregister_all()
            .map_err(|_| "shortcut_failed")
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
        ] {
            assert!(parse_binding(binding).is_err(), "{binding}");
        }
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
