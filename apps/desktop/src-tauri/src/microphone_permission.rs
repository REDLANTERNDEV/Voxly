//! Native microphone consent. The remote document cannot grant itself access.
#[cfg(any(windows, test))]
fn decision(choice: Option<bool>, current: bool) -> (bool, bool) {
    match (choice, current) {
        (Some(allowed), true) => (allowed, true),
        _ => (false, false),
    }
}

#[cfg(windows)]
mod windows_adapter {
    use super::decision;
    use crate::{installations, shell};
    use std::cell::Cell;
    use std::rc::Rc;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use tauri::{Manager, WebviewWindow};
    use webview2_com::{
        take_pwstr, FrameChildFrameCreatedEventHandler, FrameCreatedEventHandler,
        FramePermissionRequestedEventHandler, Microsoft::Web::WebView2::Win32::*,
        PermissionRequestedEventHandler,
    };
    use windows::core::{Interface, PCWSTR, PWSTR};
    use windows::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TDF_ALLOW_DIALOG_CANCELLATION,
    };

    fn current(window: &WebviewWindow, origin: &str) -> bool {
        let state = window.app_handle().state::<shell::Shell>();
        window.url().is_ok_and(|url| {
            shell::trust::report_caller_matches(
                state.voice_generation.load(Ordering::Acquire),
                window.label(),
                origin,
                &url,
            )
        })
    }

    // Frames handle microphone denials before the event bubbles to the main view.
    // If recursive frame events are unavailable, custom consent falls back to WebView2.
    unsafe fn watch_frame(
        frame: ICoreWebView2Frame,
        safe: Rc<Cell<bool>>,
    ) -> windows::core::Result<()> {
        let frame: ICoreWebView2Frame7 = frame.cast()?;
        let deny_safe = safe.clone();
        let deny = FramePermissionRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = Default::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE {
                    let Ok(persistent) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                    else {
                        deny_safe.set(false);
                        return Ok(());
                    };
                    persistent.SetSavesInProfile(false)?;
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    args.SetHandled(true)?;
                }
            }
            Ok(())
        }));
        let mut token = 0;
        frame.add_PermissionRequested(&deny, &mut token)?;
        let children = FrameChildFrameCreatedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                if args
                    .Frame()
                    .and_then(|frame| watch_frame(frame, safe.clone()))
                    .is_err()
                {
                    safe.set(false);
                }
            }
            Ok(())
        }));
        frame.add_FrameCreated(&children, &mut token)
    }

    unsafe fn prompt(
        window: &WebviewWindow,
        origin: &str,
        tr: bool,
    ) -> windows::core::Result<Option<bool>> {
        let title = wide("Voxly");
        let instruction = wide(if tr {
            "Mikrofon erişimine izin verilsin mi?"
        } else {
            "Allow microphone access?"
        });
        let content = wide(&if tr {
            format!("{origin}\n\nBu kurulum sesli aramalar ve mikrofon testi için mikrofonunuzu kullanmak istiyor. Seçiminiz bu bilgisayarda hatırlanır.")
        } else {
            format!("{origin}\n\nThis installation wants to use your microphone for voice calls and microphone testing. Your choice is remembered on this computer.")
        });
        let allow = wide(if tr {
            "Mikrofona izin ver"
        } else {
            "Allow microphone"
        });
        let block = wide(if tr { "Engelle" } else { "Block" });
        let buttons = [
            TASKDIALOG_BUTTON {
                nButtonID: 100,
                pszButtonText: PCWSTR(allow.as_ptr()),
            },
            TASKDIALOG_BUTTON {
                nButtonID: 101,
                pszButtonText: PCWSTR(block.as_ptr()),
            },
        ];
        let config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: window
                .hwnd()
                .map_err(|_| windows::core::Error::from_win32())?,
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            pszMainInstruction: PCWSTR(instruction.as_ptr()),
            pszContent: PCWSTR(content.as_ptr()),
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: 101,
            ..Default::default()
        };
        let mut button = 0;
        TaskDialogIndirect(&config, Some(&mut button), None, None)?;
        Ok(match button {
            100 => Some(true),
            101 => Some(false),
            _ => None,
        })
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub(crate) unsafe fn install(
        window: WebviewWindow,
        core: &ICoreWebView2,
        origin: String,
        epoch: Arc<AtomicU64>,
    ) {
        let Ok(view) = core.cast::<ICoreWebView2_4>() else {
            return;
        };
        let safe = Rc::new(Cell::new(true));
        let frame_safe = safe.clone();
        let frames = FrameCreatedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                if args
                    .Frame()
                    .and_then(|frame| watch_frame(frame, frame_safe.clone()))
                    .is_err()
                {
                    frame_safe.set(false);
                }
            }
            Ok(())
        }));
        let mut token = 0;
        if view.add_FrameCreated(&frames, &mut token).is_err() {
            return;
        }
        let pending = Rc::new(Cell::new(false));
        let handler = PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut kind = Default::default();
            args.PermissionKind(&mut kind)?;
            if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE || !safe.get() {
                return Ok(());
            }
            let Ok(args) = args.cast::<ICoreWebView2PermissionRequestedEventArgs3>() else {
                return Ok(());
            };
            let mut handled = windows::core::BOOL(0);
            args.Handled(&mut handled)?;
            if handled.as_bool() {
                return Ok(());
            }
            let mut state = COREWEBVIEW2_PERMISSION_STATE_DEFAULT;
            args.State(&mut state)?;
            if state != COREWEBVIEW2_PERMISSION_STATE_DEFAULT {
                return Ok(());
            }
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let matches = url::Url::parse(&take_pwstr(uri))
                .is_ok_and(|url| installations::same_origin(&origin, &url));
            let stamp = epoch.load(Ordering::Acquire);
            if !matches || !current(&window, &origin) || pending.get() {
                args.SetSavesInProfile(false)?;
                args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                args.SetHandled(true)?;
                return Ok(());
            }
            let tr = {
                let shell = window.app_handle().state::<shell::Shell>();
                let Some(language) = shell.language() else {
                    return Ok(());
                };
                language == installations::Language::Tr
            };
            args.SetHandled(true)?;
            let deferral = match args.GetDeferral() {
                Ok(deferral) => deferral,
                Err(_) => {
                    args.SetHandled(false)?;
                    return Ok(());
                }
            };
            pending.set(true);
            // TaskDialog runs an owned modal message loop. No shell mutex is held.
            let result = prompt(&window, &origin, tr);
            pending.set(false);
            let result = (|| -> windows::core::Result<()> {
                let still_current = safe.get()
                    && current(&window, &origin)
                    && epoch.load(Ordering::Acquire) == stamp;
                match result {
                    Err(_) if still_current => {
                        args.SetHandled(false)?;
                    }
                    result => {
                        let (allow, save) = decision(result.ok().flatten(), still_current);
                        args.SetSavesInProfile(save)?;
                        args.SetState(if allow {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        })?;
                    }
                }
                Ok(())
            })();
            deferral.Complete()?;
            result
        }));
        let _ = core.add_PermissionRequested(&handler, &mut token);
    }
}

#[cfg(windows)]
pub(crate) use windows_adapter::install;

#[cfg(test)]
mod tests {
    use super::decision;
    #[test]
    fn only_explicit_current_choices_are_persisted() {
        assert_eq!(decision(Some(true), true), (true, true));
        assert_eq!(decision(Some(false), true), (false, true));
        assert_eq!(decision(None, true), (false, false));
        for choice in [Some(true), Some(false), None] {
            assert_eq!(decision(choice, false), (false, false));
        }
    }
}
