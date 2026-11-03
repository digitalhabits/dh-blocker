//! Application presence only. Never opens browser profiles or extension data.
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize)]
pub struct BrowserInstallation {
    pub installed: bool,
}

fn inventory_with(
    mut installed: impl FnMut(&str) -> bool,
) -> BTreeMap<String, BrowserInstallation> {
    [
        ("safari", "com.apple.Safari"),
        ("chrome", "com.google.Chrome"),
        ("edge", "com.microsoft.edgemac"),
        ("brave", "com.brave.Browser"),
        ("firefox", "org.mozilla.firefox"),
    ]
    .into_iter()
    .map(|(key, bundle)| {
        (
            key.into(),
            BrowserInstallation {
                installed: installed(bundle),
            },
        )
    })
    .collect()
}

#[cfg(target_os = "macos")]
pub fn installed() -> BTreeMap<String, BrowserInstallation> {
    inventory_with(|bundle| {
        use cocoa::base::{id, nil};
        use cocoa::foundation::{NSAutoreleasePool, NSString};
        use objc::{msg_send, sel, sel_impl};
        unsafe {
            let Some(class) = objc::runtime::Class::get("NSWorkspace") else {
                return false;
            };
            let workspace: id = msg_send![class, sharedWorkspace];
            if workspace.is_null() {
                return false;
            }
            // This command can run on a Tauri worker without an AppKit event
            // loop pool. The temporary URL must not outlive this query.
            let pool = NSAutoreleasePool::new(nil);
            let identifier = NSString::alloc(nil).init_str(bundle);
            let url: id = msg_send![workspace, URLForApplicationWithBundleIdentifier: identifier];
            let _: () = msg_send![identifier, release];
            let installed = !url.is_null();
            pool.drain();
            installed
        }
    })
}

#[cfg(not(target_os = "macos"))]
pub fn installed() -> BTreeMap<String, BrowserInstallation> {
    inventory_with(|_| false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_permission_inventory_has_exact_frontend_shape() {
        let inventory = inventory_with(|bundle| bundle == "org.mozilla.firefox");
        let value = serde_json::to_value(inventory).unwrap();
        assert_eq!(value["firefox"], serde_json::json!({"installed":true}));
        assert_eq!(value["safari"], serde_json::json!({"installed":false}));
        assert_eq!(value.as_object().unwrap().len(), 5);
        assert!(!value.to_string().contains("profile"));
    }
}
