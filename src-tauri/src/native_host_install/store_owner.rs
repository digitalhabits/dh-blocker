//! MSIX leaves the browser-visible staged host in AppData after removal.
//! Check registration for this user on every publication, including reconnects.
#[cfg(target_os = "windows")]
pub(super) fn record(stage: &std::path::Path) -> std::io::Result<()> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS};
    use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFamilyName;

    let mut length = 0;
    let probe = unsafe { GetCurrentPackageFamilyName(&mut length, None) };
    if probe != ERROR_INSUFFICIENT_BUFFER || length == 0 {
        return Err(std::io::Error::from_raw_os_error(probe.0 as i32));
    }
    let mut buffer = vec![0; length as usize];
    let status =
        unsafe { GetCurrentPackageFamilyName(&mut length, Some(PWSTR(buffer.as_mut_ptr()))) };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(status.0 as i32));
    }
    let family =
        String::from_utf16(&buffer[..length as usize - 1]).map_err(std::io::Error::other)?;
    let path = stage.join("package-family");
    if std::fs::read_to_string(&path).ok().as_ref() != Some(&family) {
        std::fs::create_dir_all(stage)?;
        crate::commands::write_data_file_atomic(&path, family.as_bytes())?;
    }
    Ok(())
}

fn owner_present(
    staged: bool,
    family: impl FnOnce() -> Option<String>,
    installed: impl FnOnce(&str) -> bool,
) -> bool {
    !staged
        || family()
            .filter(|s| !s.is_empty())
            .is_some_and(|s| installed(&s))
}

#[cfg(target_os = "windows")]
pub(crate) fn present() -> bool {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows::Win32::Storage::Packaging::Appx::GetPackagesByPackageFamily;

    let (Ok(exe), Some(stage)) = (std::env::current_exe(), super::native_host_stage_dir()) else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    let marker = dir.join("package-family");
    // A browser can launch the staged executable via an alternative spelling
    // of AppData (case, junction or extended-length prefix).
    let staged = dir == stage || marker.is_file() || dir.join("AppxManifest.xml").is_file();
    owner_present(
        staged,
        || std::fs::read_to_string(marker).ok(),
        |family| {
            let mut count = 0;
            let mut length = 0;
            let status = unsafe {
                GetPackagesByPackageFamily(
                    &HSTRING::from(family),
                    &mut count,
                    None,
                    &mut length,
                    None,
                )
            };
            status == ERROR_INSUFFICIENT_BUFFER && count > 0
        },
    )
}

#[cfg(test)]
#[test]
fn staged_host_withdraws_on_uninstall_or_missing_owner_but_direct_install_survives() {
    let family = || Some(String::from("test_family"));
    assert!(owner_present(true, family, |s| s == "test_family"));
    assert!(!owner_present(true, family, |_| false));
    assert!(!owner_present(true, || None, |_| true));
    assert!(owner_present(false, || panic!(), |_| panic!()));
}
