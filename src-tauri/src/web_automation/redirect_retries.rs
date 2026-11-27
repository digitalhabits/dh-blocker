//! A beforeunload prompt can leave AppleScript reporting the block page for
//! as long as the user takes to decide. Start the grace period when the
//! original URL is first seen again after observing the matching block page.

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
    progress: Progress,
}

#[derive(Clone, Copy)]
enum Progress {
    Issued,
    OnBlockPage,
    WaitingUntil(Instant),
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
                match attempt.progress {
                    // A successful script can swallow per-tab errors. Without
                    // an observed navigation, leave the next redirect eligible.
                    Progress::Issued => continue,
                    Progress::OnBlockPage => {
                        attempt.progress = Progress::WaitingUntil(now + RETRY_DELAY)
                    }
                    Progress::WaitingUntil(_) => {}
                }
            } else if is_block_page_url(&tab.url, base)
                && original_url_from_block_page(&tab.url).as_ref() == Some(&attempt.original)
            {
                // The document replaces #pending with #loaded only after
                // navigation commits. Back from it starts a fresh visit.
                if tab.url.ends_with("#loaded") {
                    continue;
                }
                attempt.progress = Progress::OnBlockPage;
            } else {
                continue;
            }
            self.tabs.insert(key, attempt);
        }
        actions.retain(|(window, tab, target)| {
            !is_block_page_url(target, base)
                || !matches!(self.tabs.get(&(window.clone(), *tab)).map(|a| a.progress),
                    Some(Progress::WaitingUntil(deadline)) if now < deadline)
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
                        progress: Progress::Issued,
                    },
                );
            }
        }
    }
}
