//! Taskbar / title-bar icon for the main window on Windows.
//!
//! Tauri's window icon goes through tao's `RgbaIcon::into_windows_icon`,
//! which builds the `CreateIcon` AND mask with one *byte* per pixel where
//! Win32 expects one *bit*. Windows then reads a scrambled mask, and every
//! partially transparent pixel — the anti-aliased rounded corners of our
//! icon — renders with red fringes on the taskbar. It also hands Windows a
//! single 128 px bitmap to shrink, ignoring the hand-sized frames in
//! `icons/icon.ico`.
//!
//! Instead, load the `.ico` that `tauri-build` already embeds in the
//! executable (resource id 32512, from `bundle.icon`) and set it with
//! `WM_SETICON`, letting `LoadImageW` pick the frame closest to each size.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
use windows::Win32::UI::WindowsAndMessaging::{
    LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, LR_DEFAULTCOLOR, SM_CXICON,
    SM_CXSMICON, SYSTEM_METRICS_INDEX, WM_SETICON,
};

/// Icon resource id `tauri-build` assigns to `icons/icon.ico`.
const APP_ICON_RESOURCE_ID: u16 = 32512;

/// Replace the window's small and big icons with the embedded `.ico`.
///
/// Failure is cosmetic only, so it is logged and the icon Tauri set stays.
pub fn apply_embedded_icon(hwnd: HWND) {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    for (kind, metric) in [(ICON_SMALL, SM_CXSMICON), (ICON_BIG, SM_CXICON)] {
        if let Err(e) = set_icon(hwnd, dpi, kind, metric) {
            eprintln!("[windows_icon] WM_SETICON {kind}: {e}");
        }
    }
}

fn set_icon(
    hwnd: HWND,
    dpi: u32,
    kind: u32,
    metric: SYSTEM_METRICS_INDEX,
) -> windows::core::Result<()> {
    unsafe {
        let module = GetModuleHandleW(None)?;
        let size = GetSystemMetricsForDpi(metric, dpi);
        // MAKEINTRESOURCEW: an integer resource id passed as a pointer.
        let name = PCWSTR(APP_ICON_RESOURCE_ID as usize as *const u16);
        // Not LR_SHARED: WM_SETICON does not take ownership, but the window
        // keeps using the handle for its whole lifetime, which is the
        // process's lifetime — so it is deliberately never destroyed.
        let icon = LoadImageW(
            Some(module.into()),
            name,
            IMAGE_ICON,
            size,
            size,
            LR_DEFAULTCOLOR,
        )?;
        SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(kind as usize)),
            Some(LPARAM(icon.0 as isize)),
        );
    }
    Ok(())
}
