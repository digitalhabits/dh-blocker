// Organisation browser policies that stop Chromium browsers launching our
// per-user native-messaging host, so the extension never receives blocks.
// Only an IT department can change these; we detect them to say so loudly.
// Windows reads the registry; macOS reads MDM managed preferences.

use serde::Serialize;

use crate::native_host_install::HOST_NAME;

/// Native-messaging policy values from one registry hive (mandatory level only;
/// Chromium ignores `Recommended` for these policies).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PolicyLevel {
    pub user_level_hosts: Option<u32>,
    pub blocklist: Vec<String>,
    pub allowlist: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NativeMessagingPolicy {
    pub browser: &'static str,
    pub machine: PolicyLevel,
    pub user: PolicyLevel,
    pub blocked: bool,
}

/// Chromium's rule, with machine (HKLM) policy winning over user (HKCU) policy
/// value by value: user-level hosts switched off, or our host blocklisted (by
/// name or `*`) and not allowlisted. The allowlist never lifts the first.
pub fn blocks_host(machine: &PolicyLevel, user: &PolicyLevel) -> bool {
    fn pick<'a>(m: &'a [String], u: &'a [String]) -> &'a [String] {
        if m.is_empty() {
            u
        } else {
            m
        }
    }
    let (block, allow) = (
        pick(&machine.blocklist, &user.blocklist),
        pick(&machine.allowlist, &user.allowlist),
    );
    machine.user_level_hosts.or(user.user_level_hosts) == Some(0)
        || (block.iter().any(|h| h == "*" || h == HOST_NAME)
            && !allow.iter().any(|h| h == HOST_NAME))
}

/// macOS: MDM writes these as managed preferences, device-wide and per user.
/// A missing file costs one failed open, so unmanaged Macs pay next to nothing.
/// Per-user values are treated as winning, following the CFPreferences search
/// order (untested: no managed Mac to try it on). Failures fall towards no warning.
#[cfg(target_os = "macos")]
pub fn read(browser: crate::native_host_install::BrowserTarget) -> Option<NativeMessagingPolicy> {
    use crate::native_host_install::BrowserTarget;
    let (name, domain) = match browser {
        BrowserTarget::Chrome => ("chrome", "com.google.Chrome"),
        BrowserTarget::Edge => ("edge", "com.microsoft.Edge"),
        BrowserTarget::Brave => ("brave", "com.brave.Browser"),
        BrowserTarget::Firefox => return None, // Firefox has no such policy
    };
    let dir = std::path::Path::new("/Library/Managed Preferences");
    let file = format!("{domain}.plist");
    let user = std::env::var("USER")
        .map(|u| read_plist_level(&dir.join(u).join(&file)))
        .unwrap_or_default();
    let machine = read_plist_level(&dir.join(&file));
    let blocked = blocks_host(&user, &machine);
    Some(NativeMessagingPolicy {
        browser: name,
        machine,
        user,
        blocked,
    })
}

#[cfg(target_os = "macos")]
fn read_plist_level(path: &std::path::Path) -> PolicyLevel {
    let Ok(plist::Value::Dictionary(d)) = plist::Value::from_file(path) else {
        return PolicyLevel::default();
    };
    let list = |key: &str| -> Vec<String> {
        d.get(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_string().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    PolicyLevel {
        user_level_hosts: d
            .get("NativeMessagingUserLevelHosts")
            .and_then(|v| v.as_boolean())
            .map(u32::from),
        blocklist: list("NativeMessagingBlocklist"),
        allowlist: list("NativeMessagingAllowlist"),
    }
}

/// Read one browser's policies. A missing key or failed read counts as "no
/// policy", so failures fall towards no warning: a missed warning leaves
/// today's behaviour, a wrong one would call a working browser broken.
#[cfg(target_os = "windows")]
pub fn read(browser: crate::native_host_install::BrowserTarget) -> Option<NativeMessagingPolicy> {
    use crate::native_host_install::BrowserTarget;
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let (name, key) = match browser {
        BrowserTarget::Chrome => ("chrome", r"SOFTWARE\Policies\Google\Chrome"),
        BrowserTarget::Edge => ("edge", r"SOFTWARE\Policies\Microsoft\Edge"),
        BrowserTarget::Brave => ("brave", r"SOFTWARE\Policies\BraveSoftware\Brave"),
        BrowserTarget::Firefox => return None, // Firefox has no such policy
    };
    let (machine, user) = (
        read_level(HKEY_LOCAL_MACHINE, key),
        read_level(HKEY_CURRENT_USER, key),
    );
    let blocked = blocks_host(&machine, &user);
    Some(NativeMessagingPolicy {
        browser: name,
        machine,
        user,
        blocked,
    })
}

#[cfg(target_os = "windows")]
fn read_level(root: windows::Win32::System::Registry::HKEY, key: &str) -> PolicyLevel {
    PolicyLevel {
        user_level_hosts: read_dword(root, key, "NativeMessagingUserLevelHosts"),
        blocklist: read_list(root, &format!(r"{key}\NativeMessagingBlocklist")),
        allowlist: read_list(root, &format!(r"{key}\NativeMessagingAllowlist")),
    }
}

#[cfg(target_os = "windows")]
fn read_dword(root: windows::Win32::System::Registry::HKEY, key: &str, value: &str) -> Option<u32> {
    use crate::native_host_install::to_wide;
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, RRF_RT_REG_DWORD};
    let (key, value) = (to_wide(key), to_wide(value));
    let (mut data, mut size) = (0u32, 4u32);
    let status = unsafe {
        RegGetValueW(
            root,
            PCWSTR(key.as_ptr()),
            PCWSTR(value.as_ptr()),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        )
    };
    status.is_ok().then_some(data)
}

/// List policies are a subkey of string values named "1", "2", …
#[cfg(target_os = "windows")]
fn read_list(root: windows::Win32::System::Registry::HKEY, key: &str) -> Vec<String> {
    use crate::native_host_install::to_wide;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, KEY_READ, REG_SZ,
    };
    let mut out = Vec::new();
    let key = to_wide(key);
    let mut hkey = HKEY::default();
    unsafe {
        if RegOpenKeyExW(root, PCWSTR(key.as_ptr()), Some(0), KEY_READ, &mut hkey).is_err() {
            return out;
        }
        for i in 0.. {
            let (mut name, mut data) = ([0u16; 64], [0u16; 512]);
            let (mut name_len, mut data_len, mut ty) =
                (name.len() as u32, (data.len() * 2) as u32, 0u32);
            let status = RegEnumValueW(
                hkey,
                i,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                None,
                Some(&mut ty),
                Some(data.as_mut_ptr() as *mut u8),
                Some(&mut data_len),
            );
            if status.is_err() {
                break;
            }
            if ty == REG_SZ.0 {
                let s = String::from_utf16_lossy(&data[..data_len as usize / 2]);
                out.push(s.trim_end_matches('\0').to_string());
            }
        }
        let _ = RegCloseKey(hkey);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(user_level_hosts: Option<u32>, block: &[&str], allow: &[&str]) -> PolicyLevel {
        let v = |l: &[&str]| l.iter().map(|s| s.to_string()).collect();
        PolicyLevel {
            user_level_hosts,
            blocklist: v(block),
            allowlist: v(allow),
        }
    }
    const NONE: fn() -> PolicyLevel = PolicyLevel::default;

    #[test]
    fn no_policy_is_not_blocked() {
        assert!(!blocks_host(&NONE(), &NONE()));
    }

    #[test]
    fn user_level_hosts_off_blocks_from_either_hive() {
        assert!(blocks_host(&level(Some(0), &[], &[]), &NONE()));
        assert!(blocks_host(&NONE(), &level(Some(0), &[], &[])));
    }

    #[test]
    fn machine_value_wins_over_user_value() {
        assert!(!blocks_host(
            &level(Some(1), &[], &[]),
            &level(Some(0), &[], &[])
        ));
        assert!(blocks_host(
            &level(Some(0), &[], &[]),
            &level(Some(1), &[], &[])
        ));
    }

    #[test]
    fn allowlist_does_not_lift_user_level_hosts_off() {
        assert!(blocks_host(&level(Some(0), &[], &[HOST_NAME]), &NONE()));
    }

    #[test]
    fn blocklist_by_wildcard_or_name_unless_allowlisted() {
        assert!(blocks_host(&level(None, &["*"], &[]), &NONE()));
        assert!(blocks_host(&NONE(), &level(None, &[HOST_NAME], &[])));
        assert!(!blocks_host(&level(None, &["*"], &[HOST_NAME]), &NONE()));
        assert!(!blocks_host(
            &level(None, &["com.other.host"], &[]),
            &NONE()
        ));
    }
}
