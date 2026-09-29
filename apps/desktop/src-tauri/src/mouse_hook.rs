use std::cell::RefCell;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use tauri::AppHandle;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, UnhookWindowsHookEx, MSLLHOOKSTRUCT, MSG, PM_NOREMOVE, WH_MOUSE_LL, WM_QUIT,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::shortcuts::{ALT, CONTROL, SHIFT, SUPER};

#[derive(Clone, Copy)]
pub struct MouseEvent {
    pub button: u8,
    pub modifiers: u8,
    pub pressed: bool,
}

struct HookThread {
    id: u32,
    join: JoinHandle<()>,
}

static HOOK: OnceLock<Mutex<Option<HookThread>>> = OnceLock::new();
thread_local! {
    static APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
}

fn modifier_down(key: u16) -> bool {
    // GetAsyncKeyState's high bit is the current down state.
    unsafe { GetAsyncKeyState(key as i32) as u16 & 0x8000 != 0 }
}

fn current_modifiers() -> u8 {
    let mut result = 0;
    if modifier_down(VK_CONTROL) {
        result |= CONTROL;
    }
    if modifier_down(VK_MENU) {
        result |= ALT;
    }
    if modifier_down(VK_SHIFT) {
        result |= SHIFT;
    }
    if modifier_down(VK_LWIN) || modifier_down(VK_RWIN) {
        result |= SUPER;
    }
    result
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code == 0 && matches!(wparam as u32, WM_MBUTTONDOWN | WM_MBUTTONUP | WM_XBUTTONDOWN | WM_XBUTTONUP) {
        // Windows supplies MSLLHOOKSTRUCT only for HC_ACTION (code 0).
        let mouse = unsafe { &*(lparam as *const MSLLHOOKSTRUCT) };
        let button = match wparam as u32 {
            WM_MBUTTONDOWN | WM_MBUTTONUP => Some(3),
            _ => match mouse.mouseData >> 16 {
                1 => Some(4),
                2 => Some(5),
                _ => None,
            },
        };
        if let Some(button) = button {
            let event = MouseEvent {
                button,
                modifiers: current_modifiers(),
                pressed: matches!(wparam as u32, WM_MBUTTONDOWN | WM_XBUTTONDOWN),
            };
            APP.with(|slot| {
                if let Some(app) = slot.borrow().as_ref() {
                    let app = app.clone();
                    let dispatch = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        crate::handle_mouse_shortcut(&dispatch, event)
                    });
                }
            });
        }
    }
    // The physical click must still reach the game and every other hook.
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

pub fn register(app: &AppHandle) -> Result<(), &'static str> {
    let mut hook = HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "shortcut_failed")?;
    if hook.is_some() {
        return Ok(());
    }
    let (send, receive) = mpsc::sync_channel(1);
    let app = app.clone();
    let join = thread::Builder::new()
        .name("voxly-mouse-shortcut".into())
        .spawn(move || {
            APP.with(|slot| *slot.borrow_mut() = Some(app));
            // A message queue must exist before PostThreadMessageW may stop us.
            // MSG contains only Win32 handles, integers, and a POINT; zero is valid.
            let mut message: MSG = unsafe { std::mem::zeroed() };
            unsafe {
                PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
            }
            let id = unsafe { GetCurrentThreadId() };
            let module = unsafe { GetModuleHandleW(std::ptr::null()) };
            let installed = if module.is_null() {
                std::ptr::null_mut()
            } else {
                unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), module, 0) }
            };
            if installed.is_null() {
                let _ = send.send(Err("shortcut_unavailable"));
                return;
            }
            let _ = send.send(Ok(id));
            while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
                unsafe {
                    DispatchMessageW(&message);
                }
            }
            unsafe {
                UnhookWindowsHookEx(installed);
            }
            APP.with(|slot| *slot.borrow_mut() = None);
        })
        .map_err(|_| "shortcut_unavailable")?;
    match receive.recv().map_err(|_| "shortcut_unavailable")? {
        Ok(id) => {
            *hook = Some(HookThread { id, join });
            Ok(())
        }
        Err(error) => {
            let _ = join.join();
            Err(error)
        }
    }
}

pub fn clear() -> Result<(), &'static str> {
    let mut hook = HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "shortcut_failed")?;
    let Some(running) = hook.as_ref() else {
        return Ok(());
    };
    if unsafe { PostThreadMessageW(running.id, WM_QUIT, 0, 0) } == 0 {
        return Err("shortcut_failed");
    }
    let running = hook.take().unwrap();
    running.join.join().map_err(|_| "shortcut_failed")
}
