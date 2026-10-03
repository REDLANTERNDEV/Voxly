//! NSIS launch is checked before the application exits. Paths and arguments are local.
use std::path::Path;

pub struct Prepared(#[cfg_attr(not(target_os = "windows"), allow(dead_code))] tempfile::TempDir);

impl Prepared {
    pub fn new(root: &Path, bytes: &[u8]) -> Result<Self, &'static str> {
        // Production produces a signed standalone EXE, never an archive or MSI.
        if !bytes.starts_with(b"MZ") {
            return Err("update_invalid");
        }
        std::fs::create_dir_all(root).map_err(|_| "update_install_failed")?;
        let directory = tempfile::Builder::new()
            .prefix("installer-")
            .tempdir_in(root)
            .map_err(|_| "update_install_failed")?;
        std::fs::write(directory.path().join("update.exe"), bytes)
            .map_err(|_| "update_install_failed")?;
        Ok(Self(directory))
    }

    pub fn launch(self) -> Result<(), &'static str> {
        #[cfg(target_os = "windows")]
        {
            // Explicit elevation handles the machine-wide Program Files package.
            // ShellExecuteW returns only after UAC is accepted or cancelled.
            use std::os::windows::ffi::OsStrExt;
            let verb: Vec<u16> = "runas\0".encode_utf16().collect();
            let path: Vec<u16> = self
                .0
                .path()
                .join("update.exe")
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            let arguments: Vec<u16> = "/P /R /UPDATE\0".encode_utf16().collect();
            let result = unsafe {
                windows_sys::Win32::UI::Shell::ShellExecuteW(
                    std::ptr::null_mut(),
                    verb.as_ptr(),
                    path.as_ptr(),
                    arguments.as_ptr(),
                    std::ptr::null(),
                    1,
                )
            };
            if result as isize <= 32 {
                return Err("update_install_failed");
            }
            // NSIS must be able to read its executable after this parent exits.
            let _ = self.0.keep();
            Ok(())
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("unsupported_platform")
        }
    }
}

/// Clean only our reserved staging directories; failed removals are retried next startup.
pub fn cleanup(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with("installer-")
            && entry
                .file_type()
                .is_ok_and(|kind| kind.is_dir() && !kind.is_symlink())
        {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_and_failed_launch_remove_staged_bytes() {
        let root = tempfile::tempdir().unwrap();
        assert!(Prepared::new(root.path(), b"not an exe").is_err());
        let prepared = Prepared::new(root.path(), b"MZinvalid fixture").unwrap();
        assert_eq!(
            std::fs::read(prepared.0.path().join("update.exe")).unwrap(),
            b"MZinvalid fixture"
        );
        drop(prepared);
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        let prepared = Prepared::new(root.path(), b"MZinvalid fixture").unwrap();
        assert!(prepared.launch().is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
    #[test]
    fn restart_cleanup_is_scoped_to_native_staging_directories() {
        let root = tempfile::tempdir().unwrap();
        let prepared = Prepared::new(root.path(), b"MZfixture").unwrap();
        let _ = prepared.0.keep();
        std::fs::write(root.path().join("installer-file"), "retain").unwrap();
        std::fs::create_dir(root.path().join("other")).unwrap();
        cleanup(root.path());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
        assert!(root.path().join("other").is_dir());
    }
}
