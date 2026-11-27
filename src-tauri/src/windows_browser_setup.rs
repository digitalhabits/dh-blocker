//! Reconcile Windows browser registration after loading and accepting the EULA.

#[cfg(any(target_os = "windows", test))]
use crate::blocking_method::{self, Method, METHOD_EXTENSION};
#[cfg(any(target_os = "windows", test))]
use serde_json::Value;

#[cfg(all(target_os = "windows", not(feature = "system-test")))]
pub(crate) fn require_current_eula(app: &tauri::AppHandle) -> Result<(), String> {
    let accepted = crate::commands::canonical_data_path(app)
        .is_some_and(|path| crate::cross_app_consent::has_accepted_eula_at_path(&path));
    if accepted {
        Ok(())
    } else {
        Err("Accept the current EULA before setting up a browser extension".to_string())
    }
}

/// Older versions wrote this marker even when users skipped browser setup.
/// Combine it with completed onboarding and saved website rules before
/// treating it as evidence of a previously managed browser setup.
#[cfg(any(target_os = "windows", test))]
fn legacy_website_setup(data: &Value, has_legacy_marker: bool) -> bool {
    has_legacy_marker
        && data["settings"]["onboardingComplete"].as_bool() == Some(true)
        && data["blocklists"].as_array().is_some_and(|lists| {
            lists.iter().any(|list| {
                list["websites"].as_array().is_some_and(|sites| {
                    sites
                        .iter()
                        .filter_map(Value::as_str)
                        .any(|site| !site.trim().is_empty())
                })
            })
        })
}

#[cfg(any(target_os = "windows", test))]
fn reconcile_registration(
    data: &Value,
    has_legacy_marker: bool,
    direct_install: bool,
    browser_state: impl Fn(&str) -> (bool, bool),
    repair_host: impl Fn(&str) -> std::io::Result<()>,
    repair_policy: impl Fn(&str) -> std::io::Result<()>,
) -> Result<(), String> {
    if !crate::cross_app_consent::has_current_eula(data) {
        return Ok(());
    }
    let legacy_setup = legacy_website_setup(data, has_legacy_marker);
    let methods = blocking_method::read_map_from_value(data);
    let mut errors = Vec::new();
    for browser in blocking_method::WINDOWS_BLOCKING_METHOD_KEYS {
        let explicitly_selected = methods
            .get(*browser)
            .is_some_and(|method| method == METHOD_EXTENSION);
        if !explicitly_selected && !legacy_setup {
            continue;
        }
        let (browser_installed, policy_blocked) = browser_state(browser);
        let legacy_browser = legacy_setup && browser_installed;
        if !(explicitly_selected || legacy_browser)
            || blocking_method::windows_method(&methods, browser, policy_blocked)
                != Method::Extension
        {
            continue;
        }
        if let Err(error) = repair_host(browser) {
            errors.push(format!("native host for {browser}: {error}"));
            continue;
        }
        if direct_install && legacy_browser {
            if let Err(error) = repair_policy(browser) {
                errors.push(format!("extension policy for {browser}: {error}"));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(", "))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
#[tauri::command]
pub async fn repair_windows_browser_setup(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        crate::uia_web_automation::refresh_automation_wanted();
        if !cfg!(any(feature = "system-test", debug_assertions)) {
            return tauri::async_runtime::spawn_blocking(move || repair(&app))
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    let _ = app;
    Ok(())
}

#[cfg(target_os = "windows")]
fn repair(app: &tauri::AppHandle) -> Result<(), String> {
    use crate::native_host_install;

    let Some(data) =
        crate::commands::canonical_data_path(app).and_then(|path| crate::data_cache::read(&path))
    else {
        return Ok(());
    };
    let has_legacy_marker = dirs::data_local_dir().is_some_and(|base| {
        base.join("com.reddblock")
            .join("extension-hints-installed.v1")
            .is_file()
    });
    let direct_install = !native_host_install::is_msix_packaged_exe_path(
        &std::env::current_exe().map_err(|error| error.to_string())?,
    );
    let target = |browser: &str| {
        blocking_method::native_host_target(browser).expect("supported Windows browser")
    };
    reconcile_registration(
        &data,
        has_legacy_marker,
        direct_install,
        |browser| {
            (
                crate::profile_scan::find_browser_exe(browser).is_some(),
                crate::browser_policy::read(target(browser)).is_some_and(|policy| policy.blocked),
            )
        },
        |browser| {
            let target = target(browser);
            if native_host_install::native_host_is_current(target) {
                Ok(())
            } else {
                native_host_install::install_native_host_for(target)
            }
        },
        |browser| crate::extension_install::install_windows_hint_for(target(browser)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::RefCell;
    use std::collections::BTreeSet;

    #[derive(Default)]
    struct Registration {
        hosts: RefCell<BTreeSet<String>>,
        policies: RefCell<BTreeSet<String>>,
    }

    impl Registration {
        fn reconcile(&self, data: &Value, has_legacy_marker: bool, direct_install: bool) {
            reconcile_registration(
                data,
                has_legacy_marker,
                direct_install,
                |browser| (browser != "brave", browser == "edge"),
                |browser| {
                    self.hosts.borrow_mut().insert(browser.to_string());
                    Ok(())
                },
                |browser| {
                    self.policies.borrow_mut().insert(browser.to_string());
                    Ok(())
                },
            )
            .unwrap();
        }
    }

    #[test]
    fn accepts_only_the_current_eula_or_its_legacy_boolean() {
        use crate::cross_app_consent::has_current_eula;
        assert!(has_current_eula(
            &json!({"settings": {"eulaAcceptedRevision": 1}})
        ));
        assert!(has_current_eula(
            &json!({"settings": {"eulaAccepted": true}})
        ));
        assert!(!has_current_eula(&json!({"settings": {}})));
        assert!(!has_current_eula(&json!({"settings": {
            "eulaAcceptedRevision": 2, "eulaAccepted": true
        }})));
    }

    #[test]
    fn opted_out_or_app_only_accounts_do_not_gain_registrations() {
        let mut data = json!({
            "settings": {"onboardingComplete": true},
            "blocklists": [{"websites": ["example.org"]}]
        });
        let registry = Registration::default();
        registry.reconcile(&data, true, true); // EULA pending
        data["settings"]["eulaAcceptedRevision"] = json!(1);
        registry.reconcile(&data, false, true); // No legacy setup
        data["settings"]["onboardingComplete"] = json!(false);
        registry.reconcile(&data, true, true); // Onboarding pending
        data["settings"]["onboardingComplete"] = json!(true);
        data["blocklists"][0] = json!({"apps": ["Game.exe"], "websites": []});
        registry.reconcile(&data, true, true); // App-only rules
        assert!(registry.hosts.into_inner().is_empty());
        assert!(registry.policies.into_inner().is_empty());
    }

    #[test]
    fn repairs_missing_legacy_policies_for_installed_extension_mode_browsers() {
        let data = json!({
            "settings": {
                "eulaAccepted": true,
                "onboardingComplete": true,
                "blockingMethods": {"firefox": "automation"}
            },
            "blocklists": [{"websites": ["example.org"]}]
        });
        let registry = Registration::default();
        registry.reconcile(&data, true, true);
        assert_eq!(
            registry.hosts.into_inner(),
            BTreeSet::from(["chrome".into()])
        );
        assert_eq!(
            registry.policies.into_inner(),
            BTreeSet::from(["chrome".into()])
        );
    }

    #[test]
    fn store_repair_and_explicit_first_time_setup_register_hosts_without_policies() {
        let data = json!({
            "settings": {"eulaAcceptedRevision": 1, "blockingMethods": {"brave": "extension"}}
        });
        let registry = Registration::default();
        registry.reconcile(&data, false, true);
        assert_eq!(
            registry.hosts.into_inner(),
            BTreeSet::from(["brave".into()])
        );
        assert!(registry.policies.into_inner().is_empty());

        let legacy_data = json!({
            "settings": {"eulaAcceptedRevision": 1, "onboardingComplete": true},
            "blocklists": [{"websites": ["example.org"]}]
        });
        let registry = Registration::default();
        registry.reconcile(&legacy_data, true, false);
        assert_eq!(
            registry.hosts.into_inner(),
            BTreeSet::from(["chrome".into(), "firefox".into()])
        );
        assert!(registry.policies.into_inner().is_empty());
    }
}
