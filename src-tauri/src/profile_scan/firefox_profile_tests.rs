use super::*;
use std::fs;

// #165: profiles.ini keeps a default for every Firefox copy that has ever run.
// Only this copy's (`Profile 1`) has Focus, and it is not listed first.
const THIS_FIREFOX: u64 = 0x2656FF1E876E9973;

const PROFILES_INI: &str = "\
[Install11111111AAAAAAAA]
Default=Profiles/old1.default-release
Locked=1

[Install2656FF1E876E9973]
Default=Profiles/abc.Profile 1
Locked=1

[Install22222222BBBBBBBB]
Default=Profiles/old2.default
Locked=1

[Profile2]
Name=old1
IsRelative=1
Path=Profiles/old1.default-release

[Profile1]
Name=Profile 1
IsRelative=1
Path=Profiles/abc.Profile 1

[Profile0]
Name=default
IsRelative=1
Path=Profiles/old2.default
Default=1
";

fn firefox_fixture(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "redd_block_firefox_profiles_test_{}_{name}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    for dir in ["old1.default-release", "abc.Profile 1", "old2.default"] {
        fs::create_dir_all(root.join("Profiles").join(dir)).expect("mkdir");
    }
    fs::write(root.join("profiles.ini"), PROFILES_INI).expect("profiles.ini");
    let focus = root.join("Profiles/abc.Profile 1");
    let addons = format!(r#"{{"addons":[{{"id":"{FIREFOX_ID}","active":true}}]}}"#);
    fs::write(focus.join("extensions.json"), addons).expect("extensions.json");
    let prefs =
        format!(r#"{{"{FIREFOX_ID}":{{"permissions":["internal:privateBrowsingAllowed"]}}}}"#);
    fs::write(focus.join("extension-preferences.json"), prefs).expect("extension-preferences.json");
    root
}

fn defaults(profiles: &[ProfileStatus]) -> Vec<&str> {
    profiles
        .iter()
        .filter(|p| p.is_default)
        .map(|p| p.name.as_str())
        .collect()
}

#[test]
fn firefox_install_hash_matches_firefox() {
    // Real section names: this Mac's /Applications/Firefox.app, and Firefox's default Windows install.
    assert_eq!(
        firefox_install_hash(Path::new("/Applications/Firefox.app/Contents/MacOS")),
        THIS_FIREFOX
    );
    assert_eq!(
        firefox_install_hash(Path::new(r"C:\Program Files\Mozilla Firefox")),
        0x308046B0AF4A39CB
    );
}

#[test]
fn only_this_firefoxs_install_default_counts() {
    let root = firefox_fixture("this_copy");
    let profiles = firefox_profiles_at(&root, Some(THIS_FIREFOX));
    assert_eq!(defaults(&profiles), ["Profiles/abc.Profile 1"]);
    assert!(default_profile_compliant(&BrowserStatus {
        profiles,
        ..Default::default()
    }));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn an_unknown_firefox_copy_keeps_every_install_default() {
    let root = firefox_fixture("unknown_copy");
    for own_install in [None, Some(0x1234)] {
        assert_eq!(
            defaults(&firefox_profiles_at(&root, own_install)),
            [
                "Profiles/old1.default-release",
                "Profiles/abc.Profile 1",
                "Profiles/old2.default"
            ]
        );
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_section_name_without_leading_zeros_still_matches() {
    // Firefox writes the hash unpadded, so a section name can be 15 digits or fewer.
    let root = firefox_fixture("short_hash");
    let ini = PROFILES_INI.replace("2656FF1E876E9973", "6AFDA46A1A8AD48");
    fs::write(root.join("profiles.ini"), ini).expect("profiles.ini");
    assert_eq!(
        defaults(&firefox_profiles_at(&root, Some(0x6AFDA46A1A8AD48))),
        ["Profiles/abc.Profile 1"]
    );
    let _ = fs::remove_dir_all(&root);
}
