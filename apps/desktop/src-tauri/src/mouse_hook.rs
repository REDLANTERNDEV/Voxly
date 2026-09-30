use std::cell::RefCell;
use std::sync::atomic::{AtomicIsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use tauri::{AppHandle, WebviewWindow};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, PeekMessageW,
    PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    WH_MOUSE_LL, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::shortcuts::{MouseBinding, MouseShortcutGate, ALT, CONTROL, SHIFT, SUPER};

#[derive(Clone, Copy)]
pub struct MousePress {
    pub button: u8,
    pub modifiers: u8,
}

struct HookContext {
    app: AppHandle,
    gate: MouseShortcutGate,
}

struct HookThread {
    id: u32,
    join: JoinHandle<()>,
}

static HOOK: OnceLock<Mutex<Option<HookThread>>> = OnceLock::new();
static INSTALLATION_HWND: AtomicIsize = AtomicIsize::new(0);
thread_local! {
    static CONTEXT: RefCell<Option<HookContext>> = const { RefCell::new(None) };
}

pub fn set_installation_window(window: Option<&WebviewWindow>) -> Result<(), &'static str> {
    let hwnd = match window {
        Some(window) => window.hwnd().map_err(|_| "window_failed")?.0 as isize,
        None => 0,
    };
    INSTALLATION_HWND.store(hwnd, Ordering::Release);
    Ok(())
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
    if code == 0
        && matches!(
            wparam as u32,
            WM_MBUTTONDOWN | WM_MBUTTONUP | WM_XBUTTONDOWN | WM_XBUTTONUP
        )
    {
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
            let pressed = matches!(wparam as u32, WM_MBUTTONDOWN | WM_XBUTTONDOWN);
            let modifiers = if pressed { current_modifiers() } else { 0 };
            let installation_hwnd = INSTALLATION_HWND.load(Ordering::Acquire);
            let installation_focused = installation_hwnd != 0
                && unsafe { GetForegroundWindow() } as isize == installation_hwnd;
            let (app, decision) = CONTEXT.with(|slot| {
                let mut context = slot.borrow_mut();
                let Some(context) = context.as_mut() else {
                    return (None, Default::default());
                };
                let decision =
                    context
                        .gate
                        .handle(button, modifiers, pressed, installation_focused);
                (decision.dispatch.then(|| context.app.clone()), decision)
            });
            if let Some(app) = app {
                let event = MousePress { button, modifiers };
                tauri::async_runtime::spawn(crate::handle_mouse_shortcut(app, event));
            }
            if decision.suppress {
                // A bound side button must not navigate away from the active
                // installation. Other windows, including games, receive it.
                return 1;
            }
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

pub fn register(app: &AppHandle, binding: MouseBinding) -> Result<(), &'static str> {
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
            CONTEXT.with(|slot| {
                *slot.borrow_mut() = Some(HookContext {
                    app,
                    gate: MouseShortcutGate::new(binding),
                })
            });
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
            CONTEXT.with(|slot| *slot.borrow_mut() = None);
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
