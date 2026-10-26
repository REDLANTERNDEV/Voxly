//! The update card. At launch, a child process shows it while the shell checks
//! for and downloads an update. To install, a staged copy under another name
//! runs the silent installer: the installer closes every `voxly-desktop.exe`.
#![cfg_attr(not(target_os = "windows"), allow(dead_code))]
use crate::installations::Language;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub const INSTALL_FLAG: &str = "--update-card";
pub const LAUNCH_FLAG: &str = "--launch-card";
/// Passed when the card reopens a version whose update failed: no launch card,
/// so a failing installer cannot prompt again on every start.
pub const FAILED_FLAG: &str = "--update-failed";
pub const CARD_EXE: &str = "voxly-update.exe";
pub const INSTALLER_EXE: &str = "update.exe";
/// `/S` skips the language dialog and every wizard page; `/R` relaunches Voxly.
pub const INSTALLER_ARGUMENTS: &str = "/S /R /UPDATE";
pub const LAUNCHED: &str = "launched";
pub const CANCELLED: &str = "cancelled";

pub enum Request {
    Install {
        language: Language,
        version: String,
        installer: PathBuf,
        app: PathBuf,
    },
    Launch {
        language: Language,
    },
}

fn language_code(language: Language) -> &'static str {
    if language == Language::Tr {
        "tr"
    } else {
        "en"
    }
}

fn parse_language(value: OsString) -> Option<Language> {
    match value.to_str()? {
        "en" => Some(Language::En),
        "tr" => Some(Language::Tr),
        _ => None,
    }
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 80
        && version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c))
}

pub fn install_arguments(
    language: Language,
    version: &str,
    installer: &Path,
    app: &Path,
) -> Vec<OsString> {
    vec![
        INSTALL_FLAG.into(),
        language_code(language).into(),
        version.into(),
        installer.into(),
        app.into(),
    ]
}

pub fn launch_arguments(language: Language) -> Vec<OsString> {
    vec![LAUNCH_FLAG.into(), language_code(language).into()]
}

/// Only an exact card invocation matches; a `voxly://` activation never does.
pub fn request(args: impl IntoIterator<Item = OsString>) -> Option<Request> {
    let mut args = args.into_iter().skip(1);
    let flag = args.next()?;
    let language = parse_language(args.next()?)?;
    let request = if flag == LAUNCH_FLAG {
        Request::Launch { language }
    } else if flag == INSTALL_FLAG {
        let version = args.next()?.into_string().ok()?;
        if !valid_version(&version) {
            return None;
        }
        Request::Install {
            language,
            version,
            installer: PathBuf::from(args.next()?),
            app: PathBuf::from(args.next()?),
        }
    } else {
        return None;
    };
    args.next().is_none().then_some(request)
}

/// The install card runs only as the staged copy beside the verified installer.
pub fn staged(card: &Path, installer: &Path) -> bool {
    card.file_name().is_some_and(|name| name == CARD_EXE)
        && installer
            .file_name()
            .is_some_and(|name| name == INSTALLER_EXE)
        && card.parent().is_some()
        && card.parent() == installer.parent()
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Stage {
    Checking,
    Downloading,
    Installing,
    Failed,
}

pub struct Text {
    pub title: String,
    pub detail: String,
}

pub fn text(language: Language, stage: Stage, version: &str) -> Text {
    let tr = language == Language::Tr;
    let (title, detail) = match (stage, tr) {
        (Stage::Checking, false) => ("Starting Voxly".into(), "Checking for updates…".into()),
        (Stage::Checking, true) => (
            "Voxly başlatılıyor".into(),
            "Güncellemeler denetleniyor…".into(),
        ),
        (Stage::Downloading, false) => ("Updating Voxly".into(), format!("Downloading {version}…")),
        (Stage::Downloading, true) => (
            "Voxly güncelleniyor".into(),
            format!("{version} indiriliyor…"),
        ),
        (Stage::Installing, false) => (
            "Updating Voxly".into(),
            format!("Installing {version}. Voxly reopens by itself."),
        ),
        (Stage::Installing, true) => (
            "Voxly güncelleniyor".into(),
            format!("{version} kuruluyor. Voxly kendiliğinden yeniden açılır."),
        ),
        (Stage::Failed, false) => (
            "Update not installed".into(),
            "Reopening your current version.".into(),
        ),
        (Stage::Failed, true) => (
            "Güncelleme kurulamadı".into(),
            "Mevcut sürümünüz yeniden açılıyor.".into(),
        ),
    };
    Text { title, detail }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Bar {
    Hidden,
    Fraction(f32),
    Sweep,
}

/// A download with a known size fills; installing reports nothing, so it sweeps.
pub fn bar(stage: Stage, progress: Option<f32>) -> Bar {
    match (stage, progress) {
        (Stage::Checking | Stage::Failed, _) => Bar::Hidden,
        (Stage::Downloading, Some(fraction)) => Bar::Fraction(fraction.clamp(0.0, 1.0)),
        (Stage::Downloading, None) | (Stage::Installing, _) => Bar::Sweep,
    }
}

/// One line per message from the shell to the launch card, over its stdin.
#[derive(PartialEq, Debug)]
pub enum Signal {
    Download(String),
    Progress(Option<f32>),
    Install,
}

pub fn download_line(version: &str) -> String {
    format!("download {version}")
}

pub fn progress_line(downloaded: usize, total: Option<u64>) -> String {
    match total {
        Some(total) => format!("progress {downloaded} {total}"),
        None => format!("progress {downloaded} -"),
    }
}

pub const INSTALL_LINE: &str = "install";

pub fn signal(line: &str) -> Option<Signal> {
    let mut words = line.split_whitespace();
    let signal = match words.next()? {
        "download" => {
            let version = words.next()?;
            if !valid_version(version) {
                return None;
            }
            Signal::Download(version.to_string())
        }
        "progress" => {
            let downloaded: f64 = words.next()?.parse().ok()?;
            let total = words.next()?;
            Signal::Progress(if total == "-" {
                None
            } else {
                let total: f64 = total.parse().ok()?;
                (total > 0.0).then(|| (downloaded / total) as f32)
            })
        }
        INSTALL_LINE => Signal::Install,
        _ => return None,
    };
    words.next().is_none().then_some(signal)
}

/// The shell's handle on its launch card; dropping it closes the card.
pub struct LaunchCard {
    input: std::sync::Mutex<Option<std::process::ChildStdin>>,
}

impl LaunchCard {
    /// `None` when the card cannot start; the shell then opens Home at once.
    pub fn open(language: Language) -> Option<Self> {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            use std::process::{Command, Stdio};
            let mut child = Command::new(std::env::current_exe().ok()?)
                .args(launch_arguments(language))
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .ok()?;
            Some(Self {
                input: std::sync::Mutex::new(child.stdin.take()),
            })
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = language;
            None
        }
    }

    pub fn send(&self, line: &str) {
        use std::io::Write;
        let Ok(mut input) = self.input.lock() else {
            return;
        };
        if let Some(pipe) = input.as_mut() {
            if writeln!(pipe, "{line}").is_err() {
                *input = None;
            }
        }
    }

    /// End of input closes the card, as it does if the shell exits.
    pub fn close(&self) {
        if let Ok(mut input) = self.input.lock() {
            input.take();
        }
    }
}

/// Debug builds are console programs; a card must never open a console window.
#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
pub use window::{dismiss, run};

#[cfg(not(target_os = "windows"))]
pub fn run(_request: Request) -> i32 {
    1
}

#[cfg(not(target_os = "windows"))]
pub fn dismiss() {}

#[cfg(target_os = "windows")]
mod window {
    use super::{
        bar, signal, staged, text, Bar, Request, Signal, Stage, CANCELLED, FAILED_FLAG,
        INSTALLER_ARGUMENTS, LAUNCHED,
    };
    use crate::installations::Language;
    use std::cell::RefCell;
    use std::ffi::{c_void, OsStr};
    use std::io::{BufRead, Write};
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr::{null, null_mut};
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{
        CloseHandle, COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM,
    };
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        BeginPaint, BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateFontW,
        CreateRoundRectRgn, CreateSolidBrush, DeleteDC, DeleteObject, DrawTextW, EndPaint, GetDC,
        GetDeviceCaps, GetStockObject, InvalidateRect, ReleaseDC, RoundRect, SelectObject,
        SetBkMode, SetTextColor, SetWindowRgn, CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS,
        DEFAULT_CHARSET, DEFAULT_PITCH, DT_CENTER, DT_NOPREFIX, DT_SINGLELINE, DT_VCENTER,
        DT_WORDBREAK, FW_NORMAL, FW_SEMIBOLD, HDC, HFONT, LOGPIXELSY, NULL_PEN, OUT_DEFAULT_PRECIS,
        PAINTSTRUCT, SRCCOPY, TRANSPARENT,
    };
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, WaitForSingleObject, INFINITE,
    };
    use windows_sys::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, DrawIconEx,
        FindWindowExW, FindWindowW, GetClientRect, GetMessageW, KillTimer, LoadCursorW, LoadImageW,
        PostMessageW, PostQuitMessage, RegisterClassW, SetForegroundWindow, SetProcessDPIAware,
        SetTimer, SetWindowTextW, SystemParametersInfoW, TranslateMessage, CS_HREDRAW, CS_VREDRAW,
        DI_NORMAL, HICON, IDC_ARROW, IMAGE_ICON, LR_DEFAULTCOLOR, MSG, SPI_GETCLIENTAREAANIMATION,
        SPI_GETWORKAREA, SW_SHOWNORMAL, WM_APP, WM_CLOSE, WM_DESTROY, WM_ERASEBKGND, WM_PAINT,
        WM_TIMER, WNDCLASSW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
    };

    const CLASS: &str = "VoxlyUpdateCard";
    // tauri-build embeds the application icon under IDI_APPLICATION's number.
    const APP_ICON: *const u16 = 32512usize as *const u16;
    const WM_LAUNCHED: u32 = WM_APP + 1;
    const WM_EXITED: u32 = WM_APP + 2;
    const WM_SIGNAL: u32 = WM_APP + 3;
    const ANIMATION: usize = 1;
    const DISMISS: usize = 2;
    const LIMIT: usize = 3;
    // Frames per sweep at the 16 ms animation timer.
    const PERIOD: u32 = 96;
    const WIDTH: f32 = 300.0;
    const HEIGHT: f32 = 340.0;
    const TRACK_WIDTH: f32 = 180.0;
    const SEGMENT: f32 = 56.0;

    const fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
        (r as u32) | ((g as u32) << 8) | ((b as u32) << 16)
    }
    // Home's palette: background, text, muted text, hairline, accent.
    const CARD: COLORREF = rgb(0x15, 0x18, 0x1d);
    const TITLE: COLORREF = rgb(0xe8, 0xed, 0xf5);
    const MUTED: COLORREF = rgb(0xae, 0xb7, 0xc5);
    const TRACK: COLORREF = rgb(0x20, 0x25, 0x2d);
    const FILL: COLORREF = rgb(0xd1, 0xda, 0xe9);

    struct Card {
        language: Language,
        stage: Stage,
        version: String,
        progress: Option<f32>,
        // Install mode only: the installed version to reopen if the update fails.
        app: Option<PathBuf>,
        // Launch mode: close the install card this one follows, once drawn.
        replace_others: bool,
        relaunched: bool,
        scale: f32,
        animate: bool,
        frame: u32,
        icon: HICON,
        title_font: HFONT,
        detail_font: HFONT,
    }

    impl Card {
        fn dip(&self, value: f32) -> i32 {
            (value * self.scale).round() as i32
        }

        /// The window title is what Narrator reads and the taskbar shows, so it
        /// carries the stage as well as the heading.
        fn title(&self) -> Vec<u16> {
            let text = text(self.language, self.stage, &self.version);
            wide(OsStr::new(&format!("{} · {}", text.title, text.detail)))
        }

        fn relaunch(&mut self) {
            if let Some(app) = self.app.as_ref().filter(|_| !self.relaunched) {
                let _ = std::process::Command::new(app).arg(FAILED_FLAG).spawn();
                self.relaunched = true;
            }
        }
    }

    thread_local! {
        static STATE: RefCell<Option<Card>> = const { RefCell::new(None) };
    }

    fn wide(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    fn with_card<T>(action: impl FnOnce(&mut Card) -> T) -> Option<T> {
        STATE.with(|state| state.borrow_mut().as_mut().map(action))
    }

    /// The relaunched application closes an install card still waiting for it.
    pub fn dismiss() {
        let class = wide(OsStr::new(CLASS));
        unsafe {
            let card = FindWindowW(class.as_ptr(), null());
            if !card.is_null() {
                PostMessageW(card, WM_CLOSE, 0, 0);
            }
        }
    }

    pub fn run(request: Request) -> i32 {
        match request {
            Request::Launch { language } => unsafe {
                let Some(hwnd) = create(language, Stage::Checking, String::new(), None) else {
                    return 1;
                };
                read_signals(hwnd);
                pump()
            },
            Request::Install {
                language,
                version,
                installer,
                app,
            } => {
                let Ok(current) = std::env::current_exe() else {
                    return 1;
                };
                if !staged(&current, &installer) {
                    return 1;
                }
                unsafe {
                    let Some(hwnd) = create(language, Stage::Installing, version, Some(app)) else {
                        return 1;
                    };
                    start_installer(hwnd, wide(installer.as_os_str()));
                    pump()
                }
            }
        }
    }

    unsafe fn pump() -> i32 {
        let mut message = MSG::default();
        while GetMessageW(&mut message, null_mut(), 0, 0) > 0 {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        0
    }

    unsafe fn create(
        language: Language,
        stage: Stage,
        version: String,
        app: Option<PathBuf>,
    ) -> Option<HWND> {
        SetProcessDPIAware();
        let screen = GetDC(null_mut());
        let dpi = GetDeviceCaps(screen, LOGPIXELSY as i32);
        ReleaseDC(null_mut(), screen);
        let scale = if dpi > 0 { dpi as f32 / 96.0 } else { 1.0 };
        let mut animate: BOOL = 1;
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            &mut animate as *mut BOOL as *mut c_void,
            0,
        );
        let instance = GetModuleHandleW(null());
        let dip = |value: f32| (value * scale).round() as i32;
        let icon = LoadImageW(
            instance,
            APP_ICON,
            IMAGE_ICON,
            dip(72.0),
            dip(72.0),
            LR_DEFAULTCOLOR,
        );
        let face = wide(OsStr::new("Segoe UI"));
        let font = |size: f32, weight: u32| {
            CreateFontW(
                -dip(size),
                0,
                0,
                0,
                weight as i32,
                0,
                0,
                0,
                DEFAULT_CHARSET as u32,
                OUT_DEFAULT_PRECIS as u32,
                CLIP_DEFAULT_PRECIS as u32,
                CLEARTYPE_QUALITY as u32,
                DEFAULT_PITCH as u32,
                face.as_ptr(),
            )
        };
        let card = Card {
            language,
            stage,
            version,
            progress: None,
            replace_others: app.is_none(),
            app,
            relaunched: false,
            scale,
            animate: animate != 0,
            frame: 0,
            icon,
            title_font: font(17.0, FW_SEMIBOLD),
            detail_font: font(13.0, FW_NORMAL),
        };
        let title = card.title();
        STATE.with(|state| *state.borrow_mut() = Some(card));

        let class = wide(OsStr::new(CLASS));
        let description = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            hIcon: icon,
            hCursor: LoadCursorW(null_mut(), IDC_ARROW),
            lpszClassName: class.as_ptr(),
            ..Default::default()
        };
        if RegisterClassW(&description) == 0 {
            return None;
        }
        let mut area = RECT::default();
        SystemParametersInfoW(SPI_GETWORKAREA, 0, &mut area as *mut RECT as *mut c_void, 0);
        let (width, height) = (dip(WIDTH), dip(HEIGHT));
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP | WS_VISIBLE,
            area.left + (area.right - area.left - width) / 2,
            area.top + (area.bottom - area.top - height) / 2,
            width,
            height,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        if hwnd.is_null() {
            return None;
        }
        let corners = DWMWCP_ROUND;
        // Windows 10 has no rounded-corner attribute; clip to a rounded region instead.
        if DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &corners as *const i32 as *const c_void,
            std::mem::size_of::<i32>() as u32,
        ) < 0
        {
            let radius = dip(16.0);
            SetWindowRgn(
                hwnd,
                CreateRoundRectRgn(0, 0, width + 1, height + 1, radius, radius),
                1,
            );
        }
        if animate != 0 {
            SetTimer(hwnd, ANIMATION, 16, None);
        }
        SetTimer(hwnd, LIMIT, 600_000, None);
        SetForegroundWindow(hwnd);
        Some(hwnd)
    }

    /// The shell writes one line per change; end of input closes the card.
    fn read_signals(hwnd: HWND) {
        let target = hwnd as isize;
        std::thread::spawn(move || {
            let hwnd = target as HWND;
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Some(signal) = signal(&line) {
                    let signal = Box::into_raw(Box::new(signal)) as isize;
                    unsafe { PostMessageW(hwnd, WM_SIGNAL, 0, signal) };
                }
            }
            unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
        });
    }

    /// UAC blocks `ShellExecuteExW`, so the prompt waits off the window thread.
    fn start_installer(hwnd: HWND, installer: Vec<u16>) {
        let target = hwnd as isize;
        std::thread::spawn(move || {
            let hwnd = target as HWND;
            let verb = wide(OsStr::new("runas"));
            let parameters = wide(OsStr::new(INSTALLER_ARGUMENTS));
            let mut info = SHELLEXECUTEINFOW {
                cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
                fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
                hwnd,
                lpVerb: verb.as_ptr(),
                lpFile: installer.as_ptr(),
                lpParameters: parameters.as_ptr(),
                nShow: SW_SHOWNORMAL,
                ..Default::default()
            };
            let launched = unsafe { ShellExecuteExW(&mut info) } != 0;
            // The parent stays open, and keeps its update state, until it reads this line.
            let mut stdout = std::io::stdout();
            let _ = writeln!(stdout, "{}", if launched { LAUNCHED } else { CANCELLED });
            let _ = stdout.flush();
            unsafe { PostMessageW(hwnd, WM_LAUNCHED, usize::from(launched), 0) };
            if !launched {
                return;
            }
            let mut code = 0u32;
            if !info.hProcess.is_null() {
                unsafe {
                    WaitForSingleObject(info.hProcess, INFINITE);
                    GetExitCodeProcess(info.hProcess, &mut code);
                    CloseHandle(info.hProcess);
                }
            }
            unsafe { PostMessageW(hwnd, WM_EXITED, code as usize, 0) };
        });
    }

    unsafe fn apply(hwnd: HWND, signal: Signal) {
        let title = with_card(|card| {
            match signal {
                Signal::Download(version) => {
                    card.stage = Stage::Downloading;
                    card.version = version;
                    card.progress = None;
                }
                Signal::Progress(progress) => card.progress = progress,
                Signal::Install => {
                    card.stage = Stage::Installing;
                    card.progress = None;
                }
            }
            card.title()
        });
        if let Some(title) = title {
            SetWindowTextW(hwnd, title.as_ptr());
        }
        InvalidateRect(hwnd, null(), 0);
    }

    unsafe extern "system" fn procedure(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_ERASEBKGND => 1,
            WM_PAINT => {
                paint(hwnd);
                0
            }
            WM_TIMER => {
                match wparam {
                    ANIMATION => {
                        let sweeping = with_card(|card| {
                            card.frame = (card.frame + 1) % PERIOD;
                            bar(card.stage, card.progress) == Bar::Sweep
                        });
                        if sweeping == Some(true) {
                            InvalidateRect(hwnd, null(), 0);
                        }
                    }
                    DISMISS => {
                        // The relaunched application should have closed the card by now.
                        with_card(Card::relaunch);
                        DestroyWindow(hwnd);
                    }
                    LIMIT => {
                        DestroyWindow(hwnd);
                    }
                    _ => {}
                }
                0
            }
            WM_SIGNAL => {
                let signal = Box::from_raw(lparam as *mut Signal);
                apply(hwnd, *signal);
                0
            }
            WM_LAUNCHED => {
                if wparam == 0 {
                    DestroyWindow(hwnd);
                }
                0
            }
            WM_EXITED => {
                if wparam == 0 {
                    SetTimer(hwnd, DISMISS, 20_000, None);
                } else {
                    let title = with_card(|card| {
                        card.stage = Stage::Failed;
                        card.relaunch();
                        card.title()
                    });
                    if let Some(title) = title {
                        SetWindowTextW(hwnd, title.as_ptr());
                    }
                    KillTimer(hwnd, ANIMATION);
                    InvalidateRect(hwnd, null(), 0);
                    SetTimer(hwnd, DISMISS, 4_000, None);
                }
                0
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                0
            }
            _ => DefWindowProcW(hwnd, message, wparam, lparam),
        }
    }

    /// Double-buffered so the bar never flickers.
    unsafe fn paint(hwnd: HWND) {
        let mut painting = PAINTSTRUCT::default();
        let target = BeginPaint(hwnd, &mut painting);
        let mut client = RECT::default();
        GetClientRect(hwnd, &mut client);
        let dc = CreateCompatibleDC(target);
        let bitmap = CreateCompatibleBitmap(target, client.right, client.bottom);
        let previous = SelectObject(dc, bitmap);
        STATE.with(|state| {
            if let Some(card) = state.borrow().as_ref() {
                draw(dc, card, client);
            }
        });
        BitBlt(target, 0, 0, client.right, client.bottom, dc, 0, 0, SRCCOPY);
        SelectObject(dc, previous);
        DeleteObject(bitmap);
        DeleteDC(dc);
        EndPaint(hwnd, &painting);
        if with_card(|card| std::mem::take(&mut card.replace_others)) == Some(true) {
            close_other_cards(hwnd);
        }
    }

    /// Every card shares the class, so this finds the install card a relaunch
    /// followed, and closes it only now that this one is on screen.
    unsafe fn close_other_cards(own: HWND) {
        let class = wide(OsStr::new(CLASS));
        let mut other = FindWindowExW(null_mut(), null_mut(), class.as_ptr(), null());
        while !other.is_null() {
            if other != own {
                PostMessageW(other, WM_CLOSE, 0, 0);
            }
            other = FindWindowExW(null_mut(), other, class.as_ptr(), null());
        }
    }

    unsafe fn rounded(dc: HDC, area: RECT, radius: i32, color: COLORREF) {
        let brush = CreateSolidBrush(color);
        let previous = SelectObject(dc, brush);
        RoundRect(
            dc,
            area.left,
            area.top,
            area.right,
            area.bottom,
            radius,
            radius,
        );
        SelectObject(dc, previous);
        DeleteObject(brush);
    }

    unsafe fn draw(dc: HDC, card: &Card, client: RECT) {
        let width = client.right;
        SelectObject(dc, GetStockObject(NULL_PEN));
        rounded(
            dc,
            RECT {
                right: width + 1,
                bottom: client.bottom + 1,
                ..client
            },
            0,
            CARD,
        );
        if !card.icon.is_null() {
            let size = card.dip(72.0);
            DrawIconEx(
                dc,
                (width - size) / 2,
                card.dip(78.0),
                card.icon,
                size,
                size,
                0,
                null_mut(),
                DI_NORMAL,
            );
        }
        let text = text(card.language, card.stage, &card.version);
        SetBkMode(dc, TRANSPARENT as i32);
        let side = card.dip(24.0);
        let title = wide(OsStr::new(&text.title));
        let mut area = RECT {
            left: side,
            top: card.dip(178.0),
            right: width - side,
            bottom: card.dip(206.0),
        };
        SelectObject(dc, card.title_font);
        SetTextColor(dc, TITLE);
        DrawTextW(
            dc,
            title.as_ptr(),
            -1,
            &mut area,
            DT_CENTER | DT_SINGLELINE | DT_VCENTER | DT_NOPREFIX,
        );
        let detail = wide(OsStr::new(&text.detail));
        let mut area = RECT {
            top: card.dip(212.0),
            bottom: card.dip(256.0),
            ..area
        };
        SelectObject(dc, card.detail_font);
        SetTextColor(dc, MUTED);
        DrawTextW(
            dc,
            detail.as_ptr(),
            -1,
            &mut area,
            DT_CENTER | DT_WORDBREAK | DT_NOPREFIX,
        );
        let (from, to) = match bar(card.stage, card.progress) {
            Bar::Hidden => return,
            Bar::Fraction(fraction) => (0.0, TRACK_WIDTH * fraction),
            // Reduced motion holds the sweep still in the middle of the track.
            Bar::Sweep => {
                let start = if card.animate {
                    card.frame as f32 / PERIOD as f32 * (TRACK_WIDTH + SEGMENT) - SEGMENT
                } else {
                    (TRACK_WIDTH - SEGMENT) / 2.0
                };
                (start.max(0.0), (start + SEGMENT).min(TRACK_WIDTH))
            }
        };
        let left = (width - card.dip(TRACK_WIDTH)) / 2;
        let top = card.dip(282.0);
        let track = RECT {
            left,
            top,
            right: left + card.dip(TRACK_WIDTH),
            bottom: top + card.dip(4.0),
        };
        let radius = card.dip(4.0);
        rounded(dc, track, radius, TRACK);
        if to > from {
            rounded(
                dc,
                RECT {
                    left: left + card.dip(from),
                    right: left + card.dip(to),
                    ..track
                },
                radius,
                FILL,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_exact_card_invocations_are_recognised() {
        let installer = Path::new("C:/cache/updates/installer-1/update.exe");
        let app = Path::new("C:/Program Files/Voxly/voxly-desktop.exe");
        let mut args = vec![OsString::from("voxly-update.exe")];
        args.extend(install_arguments(Language::Tr, "0.1.5", installer, app));
        let Some(Request::Install {
            language,
            version,
            installer: parsed_installer,
            app: parsed_app,
        }) = request(args.clone())
        else {
            panic!("install request");
        };
        assert!(language == Language::Tr);
        assert_eq!(version, "0.1.5");
        assert_eq!(parsed_installer, installer);
        assert_eq!(parsed_app, app);

        let program = OsString::from("voxly-desktop.exe");
        let mut launch = vec![program.clone()];
        launch.extend(launch_arguments(Language::En));
        assert!(matches!(
            request(launch.clone()),
            Some(Request::Launch {
                language: Language::En
            })
        ));
        launch.push("extra".into());
        assert!(request(launch).is_none());

        assert!(request([program.clone()]).is_none());
        assert!(request([program.clone(), "voxly://join/abc".into()]).is_none());
        assert!(request([program.clone(), FAILED_FLAG.into()]).is_none());
        let mut extra = args.clone();
        extra.push("more".into());
        assert!(request(extra).is_none());
        for (index, value) in [(2, "de"), (3, "0.1.5 /D=C:\\"), (3, "")] {
            let mut changed = args.clone();
            changed[index] = value.into();
            assert!(request(changed).is_none(), "{value}");
        }
    }

    #[test]
    fn the_install_card_runs_only_beside_its_staged_installer() {
        let card = Path::new("/cache/installer-1/voxly-update.exe");
        assert!(staged(card, Path::new("/cache/installer-1/update.exe")));
        assert!(!staged(card, Path::new("/cache/installer-2/update.exe")));
        assert!(!staged(card, Path::new("/cache/installer-1/other.exe")));
        assert!(!staged(
            Path::new("/Program Files/Voxly/voxly-desktop.exe"),
            Path::new("/Program Files/Voxly/update.exe")
        ));
    }

    #[test]
    fn the_installer_runs_silently_and_relaunches_voxly() {
        let flags: Vec<_> = INSTALLER_ARGUMENTS.split(' ').collect();
        assert_eq!(flags, ["/S", "/R", "/UPDATE"]);
    }

    #[test]
    fn the_shell_reports_download_progress_line_by_line() {
        assert_eq!(
            signal(&download_line("0.2.0")),
            Some(Signal::Download("0.2.0".into()))
        );
        assert_eq!(
            signal(&progress_line(25, Some(100))),
            Some(Signal::Progress(Some(0.25)))
        );
        assert_eq!(
            signal(&progress_line(25, None)),
            Some(Signal::Progress(None))
        );
        assert_eq!(
            signal(&progress_line(25, Some(0))),
            Some(Signal::Progress(None))
        );
        assert_eq!(signal(INSTALL_LINE), Some(Signal::Install));
        for line in [
            "",
            "close",
            "download",
            "download 0.2.0 extra",
            "download 0.2.0;rm",
            "progress x 10",
            "progress 1",
        ] {
            assert_eq!(signal(line), None, "{line}");
        }
    }

    #[test]
    fn the_bar_appears_only_for_an_update() {
        assert_eq!(bar(Stage::Checking, None), Bar::Hidden);
        assert_eq!(bar(Stage::Failed, Some(0.5)), Bar::Hidden);
        assert_eq!(bar(Stage::Downloading, Some(0.5)), Bar::Fraction(0.5));
        assert_eq!(bar(Stage::Downloading, Some(1.5)), Bar::Fraction(1.0));
        assert_eq!(bar(Stage::Downloading, None), Bar::Sweep);
        assert_eq!(bar(Stage::Installing, Some(0.5)), Bar::Sweep);
    }

    #[test]
    fn card_copy_is_localised_for_every_stage() {
        let stages = [
            Stage::Checking,
            Stage::Downloading,
            Stage::Installing,
            Stage::Failed,
        ];
        for language in [Language::En, Language::Tr] {
            let titles: Vec<_> = stages
                .iter()
                .map(|stage| text(language, *stage, "0.2.0"))
                .collect();
            assert!(titles[1].detail.contains("0.2.0") && titles[2].detail.contains("0.2.0"));
            assert_ne!(titles[0].title, titles[1].title);
            assert_ne!(titles[2].title, titles[3].title);
            assert!(titles.iter().all(|text| !text.detail.is_empty()));
        }
        for stage in stages {
            assert_ne!(
                text(Language::En, stage, "0.2.0").detail,
                text(Language::Tr, stage, "0.2.0").detail
            );
        }
    }
}
