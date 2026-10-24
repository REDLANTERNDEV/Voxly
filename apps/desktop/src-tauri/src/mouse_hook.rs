use std::cell::RefCell;
use std::collections::BTreeSet;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use tauri::AppHandle;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
    PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG,
    MSLLHOOKSTRUCT, PM_NOREMOVE, WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP,
    WM_MBUTTONDOWN, WM_MBUTTONUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN,
    WM_XBUTTONUP,
};

use crate::shortcuts::{Action, MouseBinding, MouseShortcutGates, ALT, CONTROL, SHIFT, SUPER};

use crate::input_bindings::{
    observed_key, PhysicalBinding, PhysicalShortcutGates, ShortcutCapture,
};

#[derive(Clone, Copy)]
enum ObservedBinding {
    Mouse(MouseBinding),
    Physical(PhysicalBinding),
}

struct HookContext {
    app: AppHandle,
    gates: MouseShortcutGates,
    keyboard: PhysicalShortcutGates,
}

struct HookUpdate {
    action: Action,
    binding: Option<ObservedBinding>,
    done: mpsc::SyncSender<()>,
}

const UPDATE_BINDING: u32 = WM_APP + 1;

struct HookThread {
    id: u32,
    join: JoinHandle<()>,
    updates: mpsc::Sender<HookUpdate>,
    bindings: [Option<ObservedBinding>; 4],
}

static HOOK: OnceLock<Mutex<Option<HookThread>>> = OnceLock::new();

/// Input synthesized by another program (`SendInput`), as the hooks flag it.
/// A page that could inject keys could otherwise "press" its own binding.
const KEY_INJECTED: u32 = 0x10;
const MOUSE_INJECTED: u32 = 0x01;

/// A remote Installation's shortcut recording: what the person pressed, as the
/// hook saw it. `active` stops at the end of recording; the chord stays until
/// the binding is committed or the recording is discarded.
struct Capture {
    active: bool,
    keys: ShortcutCapture,
}

static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

/// Begins recording the keys the person presses, starting the hook if no
/// shortcut is using it yet.
pub fn begin_capture(app: &AppHandle) -> Result<(), &'static str> {
    {
        let mut hook = HOOK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "shortcut_failed")?;
        ensure_running(&mut hook, app)?;
    }
    *CAPTURE.lock().map_err(|_| "shortcut_failed")? = Some(Capture {
        active: true,
        keys: ShortcutCapture::default(),
    });
    Ok(())
}

/// Stops adding keys; the chord already pressed stays for the commit.
pub fn pause_capture() {
    if let Ok(mut capture) = CAPTURE.lock() {
        if let Some(capture) = capture.as_mut() {
            capture.active = false;
        }
    }
}

/// The recorded chord, once; the hook stops if nothing else needs it.
pub fn take_capture() -> Option<BTreeSet<u16>> {
    let taken = CAPTURE.lock().ok()?.take();
    if let Ok(mut hook) = HOOK.get_or_init(|| Mutex::new(None)).lock() {
        let _ = stop_if_idle(&mut hook);
    }
    taken.map(|capture| capture.keys.chord().clone())
}

fn capturing() -> bool {
    CAPTURE
        .lock()
        .map(|capture| capture.is_some())
        .unwrap_or(false)
}

/// Only presses made while a Voxly window is in front count: typing into some
/// other program during a recording is not choosing a Voxly shortcut.
fn foreground_is_voxly() -> bool {
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() {
        return false;
    }
    let mut process = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut process) };
    process == unsafe { GetCurrentProcessId() }
}

/// Called from the hook procedures for every key and observed mouse button.
/// `try_lock`, never `lock`: a low-level hook must not wait.
fn observe_capture(code: u16, pressed: bool, injected: bool) {
    if injected {
        return;
    }
    if let Ok(mut capture) = CAPTURE.try_lock() {
        if let Some(capture) = capture.as_mut() {
            if capture.active && (!pressed || foreground_is_voxly()) {
                capture.keys.observe(code, pressed);
            }
        }
    }
}
thread_local! {
    static CONTEXT: RefCell<Option<HookContext>> = const { RefCell::new(None) };
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
            observe_capture(
                0x200 + u16::from(button),
                pressed,
                mouse.flags & MOUSE_INJECTED != 0,
            );
            let modifiers = if pressed { current_modifiers() } else { 0 };
            let (app, action) = CONTEXT.with(|slot| {
                let mut context = slot.borrow_mut();
                let Some(context) = context.as_mut() else {
                    return (None, None);
                };
                for (action, state) in context.keyboard.handle(0x200 + u16::from(button), pressed) {
                    crate::shell::queue_voice_action(&context.app, action, state);
                }
                let dispatch = context.gates.handle(button, modifiers, pressed);
                (dispatch.map(|_| context.app.clone()), dispatch)
            });
            if let (Some(app), Some((action, pressed))) = (app, action) {
                crate::shell::queue_voice_action(&app, action, pressed);
            }
            // Observe shortcuts without consuming normal browser/game input.
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: usize, lparam: isize) -> isize {
    if code == 0
        && matches!(
            wparam as u32,
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP
        )
    {
        let key = unsafe { &*(lparam as *const KBDLLHOOKSTRUCT) };
        let pressed = matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
        let physical = observed_key(key.scanCode, key.flags & 1 != 0, key.vkCode);
        observe_capture(physical, pressed, key.flags & KEY_INJECTED != 0);
        let dispatch = CONTEXT.with(|slot| {
            let mut context = slot.borrow_mut();
            let context = context.as_mut()?;
            Some((
                context.app.clone(),
                context.keyboard.handle(physical, pressed),
            ))
        });
        if let Some((app, events)) = dispatch {
            for (action, pressed) in events {
                crate::shell::queue_voice_action(&app, action, pressed);
            }
        }
    }
    unsafe { CallNextHookEx(std::ptr::null_mut(), code, wparam, lparam) }
}

fn set_binding(context: &mut HookContext, action: Action, binding: Option<ObservedBinding>) {
    context.gates.set(
        action,
        match binding {
            Some(ObservedBinding::Mouse(mouse)) => Some(mouse),
            _ => None,
        },
    );
    let physical = match binding {
        Some(ObservedBinding::Physical(physical)) => Some(physical),
        _ => None,
    };
    if let Some((old, pressed)) = context.keyboard.set(action, physical) {
        crate::shell::queue_voice_action(&context.app, old, pressed);
    }
}

fn update(
    running: &mut HookThread,
    action: Action,
    binding: Option<ObservedBinding>,
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
    register_observed(app, action, ObservedBinding::Mouse(binding))
}
pub fn register_physical(
    app: &AppHandle,
    action: Action,
    binding: PhysicalBinding,
) -> Result<(), &'static str> {
    register_observed(app, action, ObservedBinding::Physical(binding))
}
fn register_observed(
    app: &AppHandle,
    action: Action,
    binding: ObservedBinding,
) -> Result<(), &'static str> {
    let mut hook = HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "shortcut_failed")?;
    ensure_running(&mut hook, app)?;
    let running = hook.as_mut().ok_or("shortcut_failed")?;
    update(running, action, Some(binding))
}

/// Starts the hook thread with no bindings if it is not already running. A
/// shortcut or a recording may be the first thing to need it.
fn ensure_running(hook: &mut Option<HookThread>, app: &AppHandle) -> Result<(), &'static str> {
    if hook.is_some() {
        return Ok(());
    }
    let (send, receive) = mpsc::sync_channel(1);
    let (updates, pending) = mpsc::channel::<HookUpdate>();
    let app = app.clone();
    let join = thread::Builder::new()
        .name("voxly-input-shortcut".into())
        .spawn(move || {
            CONTEXT.with(|slot| {
                *slot.borrow_mut() = Some(HookContext {
                    app,
                    gates: MouseShortcutGates::default(),
                    keyboard: PhysicalShortcutGates::default(),
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
            let keyboard = if module.is_null() {
                std::ptr::null_mut()
            } else {
                unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), module, 0) }
            };
            if installed.is_null() || keyboard.is_null() {
                unsafe {
                    if !installed.is_null() {
                        UnhookWindowsHookEx(installed);
                    }
                    if !keyboard.is_null() {
                        UnhookWindowsHookEx(keyboard);
                    }
                }
                let _ = send.send(Err("shortcut_unavailable"));
                return;
            }
            let _ = send.send(Ok(id));
            while unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) } > 0 {
                if message.message == UPDATE_BINDING {
                    while let Ok(update) = pending.try_recv() {
                        CONTEXT.with(|slot| {
                            if let Some(context) = slot.borrow_mut().as_mut() {
                                set_binding(context, update.action, update.binding);
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
                UnhookWindowsHookEx(keyboard);
            }
            CONTEXT.with(|slot| {
                if let Some(context) = slot.borrow_mut().as_mut() {
                    for (action, pressed) in context.keyboard.release_all() {
                        crate::shell::queue_voice_action(&context.app, action, pressed);
                    }
                }
                *slot.borrow_mut() = None;
            });
        })
        .map_err(|_| "shortcut_unavailable")?;
    match receive.recv().map_err(|_| "shortcut_unavailable")? {
        Ok(id) => {
            *hook = Some(HookThread {
                id,
                join,
                updates,
                bindings: [None; 4],
            });
            Ok(())
        }
        Err(error) => {
            let _ = join.join();
            Err(error)
        }
    }
}

/// Stops the hook thread once no shortcut and no recording needs it.
fn stop_if_idle(hook: &mut Option<HookThread>) -> Result<(), &'static str> {
    let Some(running) = hook.as_ref() else {
        return Ok(());
    };
    if running.bindings.iter().any(Option::is_some) || capturing() {
        return Ok(());
    }
    if unsafe { PostThreadMessageW(running.id, WM_QUIT, 0, 0) } == 0 {
        return Err("shortcut_failed");
    }
    if let Some(running) = hook.take() {
        running.join.join().map_err(|_| "shortcut_failed")?;
    }
    Ok(())
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
    update(running, action, None)?;
    stop_if_idle(&mut hook)
}
