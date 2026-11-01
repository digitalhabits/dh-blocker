//! Ownership check for retiring an exact app-owned registration path.
use std::path::Path;

pub fn matches_owned_path(candidate: &Path, expected: &Path) -> bool {
    if candidate
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        candidate
            .as_os_str()
            .to_string_lossy()
            .eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
    }
    #[cfg(not(target_os = "windows"))]
    {
        candidate == expected
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_owned_path_can_be_retired() {
        assert!(matches_owned_path(
            Path::new("/app/native-host/host.json"),
            Path::new("/app/native-host/host.json")
        ));
    }
    #[test]
    fn another_install_or_parent_traversal_is_not_owned() {
        let expected = Path::new("/app/native-host/host.json");
        assert!(!matches_owned_path(
            Path::new("/other/native-host/host.json"),
            expected
        ));
        assert!(!matches_owned_path(
            Path::new("/app/native-host/../host.json"),
            expected
        ));
    }
}
