//! A beforeunload prompt can leave AppleScript reporting the block page for
//! as long as the user takes to decide. Start the grace period when the
//! original URL is first seen again, even if Cancel happened between reads.

use crate::block_page::{is_block_page_url, original_url_from_block_page, Tab, TabAction};
use std::collections::HashMap;
use std::time::{Duration, Instant};

const RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Default)]
pub(super) struct RedirectRetries {
    tabs: HashMap<(String, u32), Attempt>,
}

struct Attempt {
    original: String,
    retry_at: Option<Instant>,
}

impl RedirectRetries {
    pub(super) fn observe(
        &mut self,
        tabs: &[Tab],
        actions: &mut Vec<TabAction>,
        base: &str,
        now: Instant,
    ) {
        if self.tabs.is_empty() {
            return;
        }
        let mut previous = std::mem::take(&mut self.tabs);
        for tab in tabs {
            let key = (tab.window_id.clone(), tab.tab_ref);
            let Some(mut attempt) = previous.remove(&key) else {
                continue;
            };
            if tab.url == attempt.original {
                attempt.retry_at.get_or_insert(now + RETRY_DELAY);
            } else if is_block_page_url(&tab.url, base)
                && original_url_from_block_page(&tab.url).as_ref() == Some(&attempt.original)
            {
                attempt.retry_at = None;
            } else {
                continue;
            }
            self.tabs.insert(key, attempt);
        }
        actions.retain(|(window, tab, target)| {
            !is_block_page_url(target, base)
                || self
                    .tabs
                    .get(&(window.clone(), *tab))
                    .and_then(|attempt| attempt.retry_at)
                    .map(|deadline| now >= deadline)
                    .unwrap_or(true)
        });
    }

    pub(super) fn record_actions(&mut self, actions: &[TabAction], base: &str) {
        for (window, tab, target) in actions {
            let key = (window.clone(), *tab);
            if !is_block_page_url(target, base) {
                self.tabs.remove(&key);
            } else if let Some(original) = original_url_from_block_page(target) {
                self.tabs.insert(
                    key,
                    Attempt {
                        original,
                        retry_at: None,
                    },
                );
            }
        }
    }
}
