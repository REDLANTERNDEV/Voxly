use serde::Deserialize;
use tauri::WebviewWindow;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowTheme {
    Light,
    Dark,
    #[serde(skip)]
    Welcome,
}

pub fn apply(window: &WebviewWindow, theme: WindowTheme) -> Result<(), &'static str> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{
            Graphics::Dwm::{
                DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
            },
            UI::{
                Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW},
                WindowsAndMessaging::{
                    SystemParametersInfoW, SPI_GETHIGHCONTRAST, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
                },
            },
        };
        let mut contrast = HIGHCONTRASTW {
            cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
            ..Default::default()
        };
        // Respect Windows accessibility colors. Never alter WebView2's OS theme,
        // so Voxly's Auto theme continues to follow prefers-color-scheme.
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            contrast.cbSize,
            Some(&mut contrast as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
        .map_err(|_| "window_failed")?;
        let high_contrast = contrast.dwFlags.contains(HCF_HIGHCONTRASTON);
        let colors = if high_contrast {
            [u32::MAX; 3]
        } else {
            palette(theme)
        };
        let dark: i32 =
            i32::from(!high_contrast && matches!(theme, WindowTheme::Dark | WindowTheme::Welcome));
        let hwnd = window.hwnd().map_err(|_| "window_failed")?;
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            &dark as *const _ as *const _,
            4,
        )
        .map_err(|_| "window_failed")?;
        for (attribute, color) in [DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR, DWMWA_BORDER_COLOR]
            .into_iter()
            .zip(colors)
        {
            DwmSetWindowAttribute(hwnd, attribute, &color as *const _ as *const _, 4)
                .map_err(|_| "window_failed")?;
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (window, theme);
        Err("unsupported_platform")
    }
}

#[cfg(any(windows, test))]
fn palette(theme: WindowTheme) -> [u32; 3] {
    // Caption, text and border match visual-refresh.css's bg/fg/border tokens.
    let rgb = match theme {
        WindowTheme::Light => [0xf3f5f7_u32, 0x111317, 0xcbd2d9],
        WindowTheme::Dark => [0x0b0d10_u32, 0xf2f4f7, 0x2f3944],
        WindowTheme::Welcome => [0x0e141b_u32, 0xe8eef4, 0x374857],
    };
    rgb.map(|color| ((color & 0xff) << 16) | (color & 0xff00) | ((color >> 16) & 0xff))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn theme_contract_rejects_arbitrary_colors_and_auto() {
        for value in ["auto", "#ff0000", "LIGHT", "welcome"] {
            assert!(serde_json::from_str::<WindowTheme>(&format!("\"{value}\"")).is_err());
        }
        assert_eq!(palette(WindowTheme::Dark), [0x100d0b, 0xf7f4f2, 0x44392f]);
        assert_eq!(palette(WindowTheme::Light), [0xf7f5f3, 0x171311, 0xd9d2cb]);
    }
}
