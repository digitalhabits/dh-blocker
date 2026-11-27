#[cfg(target_os = "windows")]
use std::process::Command;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[cfg(target_os = "windows")]
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    use std::os::windows::process::CommandExt;

    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(all(target_os = "windows", not(feature = "system-test")))]
pub(crate) fn system_directory() -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buffer = vec![0u16; 32768];
    let size = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
    if size == 0 || size >= buffer.len() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..size],
    )))
}

/// When Chrome spawns the native-messaging host, the process cwd is
/// often the browser's install dir, not our exe dir. Set cwd + DLL
/// search path to the host binary's folder so WebView2Loader and other
/// siblings next to `redd-block.exe` resolve (MSIX staged copy under
/// `%LOCALAPPDATA%\\Digital Habits Blocker\\native-host\\`).
#[cfg(target_os = "windows")]
pub fn set_native_host_process_directory() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    use std::os::windows::ffi::OsStrExt;

    let _ = std::env::set_current_dir(dir);
    let wide: Vec<u16> = dir
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let _ = windows::Win32::System::LibraryLoader::SetDllDirectoryW(windows::core::PCWSTR(
            wide.as_ptr(),
        ));
    }
}
