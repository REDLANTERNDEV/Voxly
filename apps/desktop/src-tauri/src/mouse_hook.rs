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
    WH_MOUSE_LL, WM_APP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::shortcuts::{Action, MouseBinding, MouseShortcutGates, ALT, CONTROL, SHIFT, SUPER};

struct HookContext {
    app: AppHandle,
    gates: MouseShortcutGates,
}

struct HookUpdate {
    action: Action,
    binding: Option<MouseBinding>,
    done: mpsc::SyncSender<()>,
}

const UPDATE_BINDING: u32 = WM_APP + 1;

struct HookThread {
    id: u32,
    join: JoinHandle<()>,
    updates: mpsc::Sender<HookUpdate>,
    bindings: [Option<MouseBinding>; 4],
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
            let (app, action, suppress) = CONTEXT.with(|slot| {
                let mut context = slot.borrow_mut();
                let Some(context) = context.as_mut() else {
                    return (None, None, false);
                };
                let (dispatch, suppress) =
                    context
                        .gates
                        .handle(button, modifiers, pressed, installation_focused);
                (dispatch.map(|_| context.app.clone()), dispatch, suppress)
            });
            if let (Some(app), Some((action, pressed))) = (app, action) {
                crate::queue_voice_action(&app, action, pressed);
            }
            if suppress {
                // A bound side button must not navigate away from the active
                // installation. Other windows, including games, receive it.
                return 1;
            }
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

fn update(
    running: &mut HookThread,
    action: Action,
    binding: Option<MouseBinding>,
) -> Result<(), &'static str> {
    let (done, finished) = mpsc::sync_channel(1);
    running
        .updates
        .send(HookUpdate {
            action,
            binding,
            done,
        })
        .map_err(|_| "shortcut_failed")?;
    if unsafe { PostThreadMessageW(running.id, UPDATE_BINDING, 0, 0) } == 0 {
        return Err("shortcut_failed");
    }
    finished.recv().map_err(|_| "shortcut_failed")?;
    running.bindings[action.index()] = binding;
    Ok(())
}

pub fn register(
    app: &AppHandle,
    action: Action,
    binding: MouseBinding,
) -> Result<(), &'static str> {
    let mut hook = HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "shortcut_failed")?;
    if let Some(running) = hook.as_mut() {
        return update(running, action, Some(binding));
    }
    let (send, receive) = mpsc::sync_channel(1);
    let (updates, pending) = mpsc::channel::<HookUpdate>();
    let app = app.clone();
    let join = thread::Builder::new()
        .name("voxly-mouse-shortcut".into())
        .spawn(move || {
            CONTEXT.with(|slot| {
                let mut gates = MouseShortcutGates::default();
                gates.set(action, Some(binding));
                *slot.borrow_mut() = Some(HookContext { app, gates })
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
                if message.message == UPDATE_BINDING {
                    while let Ok(update) = pending.try_recv() {
                        CONTEXT.with(|slot| {
                            if let Some(context) = slot.borrow_mut().as_mut() {
                                context.gates.set(update.action, update.binding);
                            }
                        });
                        let _ = update.done.send(());
                    }
                    continue;
                }
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
            let mut bindings = [None; 4];
            bindings[action.index()] = Some(binding);
            *hook = Some(HookThread {
                id,
                join,
                updates,
                bindings,
            });
            Ok(())
        }
        Err(error) => {
            let _ = join.join();
            Err(error)
        }
    }
}

pub fn clear(action: Action) -> Result<(), &'static str> {
    let mut hook = HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "shortcut_failed")?;
    let Some(running) = hook.as_mut() else {
        return Ok(());
    };
    if running.bindings[action.index()].is_none() {
        return Ok(());
    }
    if running
        .bindings
        .iter()
        .enumerate()
        .any(|(index, binding)| index != action.index() && binding.is_some())
    {
        return update(running, action, None);
    }
    if unsafe { PostThreadMessageW(running.id, WM_QUIT, 0, 0) } == 0 {
        return Err("shortcut_failed");
    }
    let running = hook.take().unwrap();
    running.join.join().map_err(|_| "shortcut_failed")
}
