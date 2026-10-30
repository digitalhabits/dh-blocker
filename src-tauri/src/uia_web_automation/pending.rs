//! Counts, not URLs, survive app restarts so expired blocks can still restore.
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Default)]
pub(super) struct Pending {
    path: PathBuf,
    entries: HashMap<String, usize>,
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
        Self { path, entries }
    }

    pub fn count(&self, key: &str) -> usize {
        self.entries.get(key).copied().unwrap_or(0)
    }

    pub fn redirected(&mut self, key: &str) {
        *self.entries.entry(key.to_owned()).or_default() += 1;
        self.save();
    }

    pub fn restored(&mut self, key: &str) {
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
