//! Idempotent retirement of app-owned legacy native messaging registrations.
//! Never scans browser profiles, modifies user extensions, or writes policies.
use std::path::PathBuf;
const HOST_NAME: &str = "com.ulriklyngs.mindshield";
#[derive(Debug, Clone, Copy)]
pub enum BrowserTarget {
    Chrome,
    Brave,
    Edge,
    Firefox,
}

impl BrowserTarget {
    #[allow(dead_code)] // iterated by the non-macOS install path
    fn all() -> [BrowserTarget; 4] {
        [
            BrowserTarget::Chrome,
            BrowserTarget::Brave,
            BrowserTarget::Edge,
            BrowserTarget::Firefox,
        ]
    }

    /// Directory where the browser expects to find native-messaging
    /// host manifests. User-scope only.
    #[cfg_attr(target_os = "windows", allow(unused_variables))] // `home` is macOS/Linux only
    fn manifest_dir(self) -> Option<PathBuf> {
        let home = dirs::home_dir()?;
        #[cfg(target_os = "macos")]
        {
            let p = match self {
                BrowserTarget::Chrome => {
                    "Library/Application Support/Google/Chrome/NativeMessagingHosts"
                }
                BrowserTarget::Brave => {
                    "Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
                }
                BrowserTarget::Edge => {
                    "Library/Application Support/Microsoft Edge/NativeMessagingHosts"
                }
                BrowserTarget::Firefox => {
                    "Library/Application Support/Mozilla/NativeMessagingHosts"
                }
            };
            Some(home.join(p))
        }
        #[cfg(target_os = "windows")]
        {
            // Windows doesn't use a per-browser directory; the manifest
            // lives wherever we want and is referenced by registry key.
            let _ = self;
            Some(crate::product_identity::windows_primary_local_product_dir()?.join("native-host"))
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            let p = match self {
                BrowserTarget::Chrome => ".config/google-chrome/NativeMessagingHosts",
                BrowserTarget::Brave => ".config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
                BrowserTarget::Edge => ".config/microsoft-edge/NativeMessagingHosts",
                BrowserTarget::Firefox => ".mozilla/native-messaging-hosts",
            };
            Some(home.join(p))
        }
    }
}

#[cfg(target_os = "windows")]
fn registry_key_path(browser: BrowserTarget) -> String {
    // All HKCU — no UAC. Chrome/Brave/Edge use the same schema under
    // their vendor key; Firefox uses Mozilla\NativeMessagingHosts.
    match browser {
        BrowserTarget::Chrome => {
            format!(r"Software\Google\Chrome\NativeMessagingHosts\{HOST_NAME}")
        }
        BrowserTarget::Brave => {
            format!(r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\{HOST_NAME}")
        }
        BrowserTarget::Edge => format!(r"Software\Microsoft\Edge\NativeMessagingHosts\{HOST_NAME}"),
        BrowserTarget::Firefox => format!(r"Software\Mozilla\NativeMessagingHosts\{HOST_NAME}"),
    }
}

#[cfg(target_os = "windows")]
fn read_hkcu_default(path: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };

    unsafe {
        let mut hkey: HKEY = HKEY::default();
        let subkey = to_wide(path);
        let status = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(subkey.as_ptr()),
            Some(0),
            KEY_READ,
            &mut hkey,
        );
        if status != ERROR_SUCCESS {
            return None;
        }
        let mut reg_type = REG_VALUE_TYPE::default();
        let mut buf_size: u32 = 0;
        let _ = RegQueryValueExW(
            hkey,
            PCWSTR::null(),
            None,
            Some(&mut reg_type),
            None,
            Some(&mut buf_size),
        );
        if buf_size == 0 {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; buf_size as usize];
        let status = RegQueryValueExW(
            hkey,
            PCWSTR::null(),
            None,
            Some(&mut reg_type),
            Some(buf.as_mut_ptr()),
            Some(&mut buf_size),
        );
        let _ = RegCloseKey(hkey);
        if status != ERROR_SUCCESS || reg_type != REG_SZ {
            return None;
        }
        let wide_len = (buf_size as usize / 2).saturating_sub(1);
        let wide = std::slice::from_raw_parts(buf.as_ptr() as *const u16, wide_len);
        String::from_utf16(wide).ok()
    }
}

#[cfg(target_os = "windows")]
fn delete_hkcu_key(path: &str) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{RegDeleteKeyW, HKEY_CURRENT_USER};

    unsafe {
        let wide = to_wide(path);
        let status = RegDeleteKeyW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr()));
        if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
            return Err(std::io::Error::other(format!(
                "RegDeleteKeyW failed: {status:?}"
            )));
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub(crate) fn to_wide(s: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
pub fn is_msix_packaged_exe_path(path: &std::path::Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case("WindowsApps")
    })
}
#[cfg(not(target_os = "windows"))]
pub fn is_msix_packaged_exe_path(_path: &std::path::Path) -> bool {
    false
}

fn manifest_owned(path: &std::path::Path) -> std::io::Result<bool> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return Ok(false);
    };
    if value.get("name").and_then(|v| v.as_str()) != Some(HOST_NAME) {
        return Ok(false);
    }
    let Some(binary) = value.get("path").and_then(|v| v.as_str()) else {
        return Ok(false);
    };
    let current = std::env::current_exe()?;
    if crate::legacy_registration::matches_owned_path(std::path::Path::new(binary), &current) {
        return Ok(true);
    }
    #[cfg(target_os = "windows")]
    if let Some(dir) = crate::product_identity::windows_primary_local_product_dir() {
        let staged = dir.join("native-host").join("redd-block.exe");
        return Ok(crate::legacy_registration::matches_owned_path(
            std::path::Path::new(binary),
            &staged,
        ));
    }
    Ok(false)
}

fn retire_manifest(path: &std::path::Path) -> std::io::Result<bool> {
    if !manifest_owned(path)? {
        return Ok(false);
    }
    std::fs::remove_file(path)?;
    Ok(true)
}

pub fn uninstall() -> std::io::Result<()> {
    for browser in BrowserTarget::all() {
        if let Some(dir) = browser.manifest_dir() {
            #[cfg(target_os = "windows")]
            let filename = format!(
                "{HOST_NAME}-{}.json",
                match browser {
                    BrowserTarget::Chrome => "chrome",
                    BrowserTarget::Brave => "brave",
                    BrowserTarget::Edge => "edge",
                    BrowserTarget::Firefox => "firefox",
                }
            );
            #[cfg(not(target_os = "windows"))]
            let filename = format!("{HOST_NAME}.json");
            let path = dir.join(filename);
            // Ambiguous registrations belonging to another installation are left alone.
            // A missing manifest may still have an exact app-owned stale
            // registration. A present foreign manifest is never touched.
            let missing = match std::fs::metadata(&path) {
                Ok(_) => false,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                Err(e) => return Err(e),
            };
            if !missing && !manifest_owned(&path)? {
                continue;
            }
            #[cfg(target_os = "windows")]
            if let Some(registered) = read_hkcu_default(&registry_key_path(browser)) {
                if crate::legacy_registration::matches_owned_path(
                    std::path::Path::new(&registered),
                    &path,
                ) {
                    delete_hkcu_key(&registry_key_path(browser))?;
                }
            }
            if !missing {
                retire_manifest(&path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str, value: &serde_json::Value) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("dh-retirement-{}-{name}.json", std::process::id()));
        std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
        path
    }
    #[test]
    fn own_manifest_is_removed_once() {
        let path = fixture(
            "own",
            &serde_json::json!({"name":HOST_NAME,"path":std::env::current_exe().unwrap()}),
        );
        assert!(retire_manifest(&path).unwrap());
        assert!(!retire_manifest(&path).unwrap());
    }
    #[test]
    fn foreign_name_and_executable_are_preserved() {
        for (label, name, binary) in [
            ("name", "another.host", std::env::current_exe().unwrap()),
            (
                "binary",
                HOST_NAME,
                PathBuf::from("/another-install/browser-host"),
            ),
        ] {
            let path = fixture(label, &serde_json::json!({"name":name,"path":binary}));
            assert!(!retire_manifest(&path).unwrap());
            assert!(path.exists());
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn malformed_manifest_is_preserved() {
        let path = fixture("malformed", &serde_json::json!({}));
        std::fs::write(&path, "{invalid").unwrap();
        assert!(!retire_manifest(&path).unwrap());
        assert!(path.exists());
        std::fs::remove_file(path).unwrap();
    }
}
