use std::cell::RefCell;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use tauri::AppHandle;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_MENU, VK_RCONTROL,
    VK_RMENU, VK_RSHIFT, VK_RWIN, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
    SetWindowsHookExW, UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, PM_NOREMOVE,
    WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
    WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
};

use crate::shortcuts::{
    Action, ModifierKey, ModifierShortcutGates, MouseBinding, MouseShortcutGates, ALT, CONTROL,
    SHIFT, SUPER,
};

#[derive(Clone, Copy)]
enum ObservedBinding {
    Mouse(MouseBinding),
    Modifier(ModifierKey),
}

struct HookContext {
    app: AppHandle,
    gates: MouseShortcutGates,
    modifiers: ModifierShortcutGates,
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
            let modifiers = if pressed { current_modifiers() } else { 0 };
            let (app, action) = CONTEXT.with(|slot| {
                let mut context = slot.borrow_mut();
                let Some(context) = context.as_mut() else {
                    return (None, None);
                };
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
        let observed = match key.vkCode {
            value if value == VK_LCONTROL as u32 => Some((ModifierKey::Control, false)),
            value if value == VK_RCONTROL as u32 => Some((ModifierKey::Control, true)),
            value if value == VK_LMENU as u32 => Some((ModifierKey::Alt, false)),
            value if value == VK_RMENU as u32 => Some((ModifierKey::Alt, true)),
            value if value == VK_LSHIFT as u32 => Some((ModifierKey::Shift, false)),
            value if value == VK_RSHIFT as u32 => Some((ModifierKey::Shift, true)),
            _ => None,
        };
        if let Some((modifier, right)) = observed {
            let pressed = matches!(wparam as u32, WM_KEYDOWN | WM_SYSKEYDOWN);
            let dispatch = CONTEXT.with(|slot| {
                let mut context = slot.borrow_mut();
                let context = context.as_mut()?;
                context
                    .modifiers
                    .handle(modifier, right, pressed)
                    .map(|event| (context.app.clone(), event))
            });
            if let Some((app, (action, pressed))) = dispatch {
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
    let modifier = match binding {
        Some(ObservedBinding::Modifier(modifier)) => Some(modifier),
        _ => None,
    };
    if let Some((old, pressed)) = context.modifiers.set(action, modifier) {
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
pub fn register_modifier(
    app: &AppHandle,
    action: Action,
    modifier: ModifierKey,
) -> Result<(), &'static str> {
    register_observed(app, action, ObservedBinding::Modifier(modifier))
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
    if let Some(running) = hook.as_mut() {
        return update(running, action, Some(binding));
    }
    let (send, receive) = mpsc::sync_channel(1);
    let (updates, pending) = mpsc::channel::<HookUpdate>();
    let app = app.clone();
    let join = thread::Builder::new()
        .name("voxly-input-shortcut".into())
        .spawn(move || {
            CONTEXT.with(|slot| {
                let mut context = HookContext {
                    app,
                    gates: MouseShortcutGates::default(),
                    modifiers: ModifierShortcutGates::default(),
                };
                set_binding(&mut context, action, Some(binding));
                *slot.borrow_mut() = Some(context)
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
                    for (action, pressed) in context.modifiers.release_all() {
                        crate::shell::queue_voice_action(&context.app, action, pressed);
                    }
                }
                *slot.borrow_mut() = None;
            });
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
