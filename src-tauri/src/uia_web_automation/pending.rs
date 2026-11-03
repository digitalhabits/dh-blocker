//! Counts, not URLs, survive app restarts so expired blocks can still restore.
use std::collections::HashMap;
use std::path::PathBuf;

use crate::{block_page, website_policy::BlockInfo};

#[derive(Default)]
pub(super) struct Pending {
    path: PathBuf,
    entries: HashMap<String, usize>,
    /// In-flight destinations stay in memory; only counts are persisted.
    restoring: HashMap<String, String>,
}

impl Pending {
    pub fn load(path: PathBuf) -> Self {
        let entries = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                // Corrupt bookkeeping cannot identify parked tabs. Allow idle
                // polling to stop; active blocks still enforce normally.
                log::warn!("uia_web_automation: invalid restore ledger: {error}");
                HashMap::new()
            }),
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!("uia_web_automation: reading restore ledger: {error}");
                }
                HashMap::new()
            }
        };
        Self {
            path,
            entries,
            restoring: HashMap::new(),
        }
    }

    /// Observe a completed restore before planning another redirect/restore.
    /// Failed reads and active editing never call this method.
    pub fn plan(
        &mut self,
        key: &str,
        text: &str,
        blocks: &[BlockInfo],
        page: &str,
    ) -> Option<String> {
        if let Some(expected) = self.restoring.get(key) {
            if block_page::address_bar_text_to_url(text).as_ref() == Some(expected) {
                self.restored(key);
                self.restoring.remove(key);
            }
        }
        block_page::plan_address_bar_action(text, blocks, page)
    }

    /// Called only after navigation succeeds. A restore remains pending until
    /// a later observation confirms its destination in this same window.
    pub fn navigated(&mut self, key: &str, target: &str, page: &str) {
        if block_page::is_block_page_url(target, page) {
            self.redirected(key);
        } else {
            self.restoring.insert(key.to_owned(), target.to_owned());
        }
    }

    pub fn count(&self, key: &str) -> usize {
        self.entries.get(key).copied().unwrap_or(0)
    }

    fn redirected(&mut self, key: &str) {
        *self.entries.entry(key.to_owned()).or_default() += 1;
        self.save();
    }

    fn restored(&mut self, key: &str) {
        if let Some(count) = self.entries.get_mut(key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.entries.remove(key);
            }
            self.save();
        }
    }

    pub fn retain(&mut self, live: impl Fn(&str) -> bool) {
        let before = self.entries.len();
        self.entries.retain(|key, _| live(key));
        self.restoring.retain(|key, _| live(key));
        if self.entries.len() != before {
            self.save();
        }
    }

    fn save(&self) {
        #[cfg(test)]
        if self.path.as_os_str().is_empty() {
            return;
        }
        let result = serde_json::to_vec(&self.entries)
            .map_err(|e| e.to_string())
            .and_then(|bytes| {
                crate::commands::write_data_file_atomic(&self.path, &bytes)
                    .map_err(|e| e.to_string())
            });
        if let Err(error) = result {
            log::warn!("uia_web_automation: saving restore ledger: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: &str = "file:///C:/Blocker/blocked/blocked.html";

    #[test]
    fn redirect_expiry_and_restore_require_observed_completion() {
        let blocks = vec![crate::website_policy::BlockInfo {
            blocklist_id: "one".into(),
            mode: "blocklist".into(),
            domains: vec!["example.com".into()],
            apps: vec![],
            name: None,
            emoji: None,
            color: None,
            source: "manual",
            ends_at: None,
            started_at: None,
        }];
        let mut pending = Pending::default();
        let parked = pending
            .plan("window:1", "example.com/", &blocks, PAGE)
            .unwrap();
        // Planning (or a failed navigation) does not change bookkeeping.
        assert_eq!(pending.count("window:1"), 0);
        pending.navigated("window:1", &parked, PAGE);
        assert_eq!(pending.count("window:1"), 1);
        assert_eq!(pending.plan("window:1", &parked, &blocks, PAGE), None);
        let restore = pending.plan("window:1", &parked, &[], PAGE).unwrap();
        assert_eq!(restore, "https://example.com/");
        pending.navigated("window:1", &restore, PAGE);
        assert_eq!(pending.count("window:1"), 1);
        // A different page, or the destination in a different window, is no confirmation.
        assert_eq!(pending.plan("window:1", "other.example/", &[], PAGE), None);
        assert_eq!(pending.plan("window:2", &restore, &[], PAGE), None);
        assert_eq!(pending.count("window:1"), 1);
        assert_eq!(pending.plan("window:1", "example.com/", &[], PAGE), None);
        assert_eq!(pending.count("window:1"), 0);
        // Re-observing the destination cannot consume another parked tab.
        pending.redirected("window:1");
        pending.plan("window:1", "example.com/", &[], PAGE);
        assert_eq!(pending.count("window:1"), 1);
    }

    #[test]
    fn closing_a_window_discards_its_in_flight_confirmation() {
        let mut pending = Pending::default();
        pending.redirected("window:1");
        pending.navigated("window:1", "https://example.com/", PAGE);
        pending.retain(|_| false);
        pending.redirected("window:1");
        pending.plan("window:1", "example.com/", &[], PAGE);
        assert_eq!(pending.count("window:1"), 1);
    }

    #[test]
    fn restart_preserves_restores_and_closed_windows_are_pruned() {
        let path = std::env::temp_dir().join(format!(
            "dh-uia-ledger-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut pending = Pending::load(path.clone());
        pending.redirected("one:1");
        pending.redirected("one:1");
        pending.redirected("two:2");
        let mut reloaded = Pending::load(path.clone());
        assert_eq!(reloaded.count("one:1"), 2);
        reloaded.retain(|key| key == "one:1");
        reloaded.restored("one:1");
        let reloaded = Pending::load(path.clone());
        assert_eq!(reloaded.count("one:1"), 1);
        assert_eq!(reloaded.count("two:2"), 0);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn two_tabs_in_one_window_need_two_confirmed_restores() {
        let mut pending = Pending::default();
        // Exercise count transitions without writing into the real app data.
        pending.entries.insert("window:pid".into(), 2);
        assert_eq!(pending.count("window:pid"), 2);
        pending.restored("window:pid");
        assert_eq!(pending.count("window:pid"), 1);
        pending.restored("window:pid");
        assert_eq!(pending.count("window:pid"), 0);
    }
}
