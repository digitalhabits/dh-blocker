//! Pure scheduling state: no browser or Windows calls.

#[derive(Default)]
pub(super) struct Activity {
    pub display_off: bool,
    pub locked: bool,
    pub disconnected: bool,
}

impl Activity {
    pub fn suspended(&self) -> bool {
        self.display_off || self.locked || self.disconnected
    }
}

pub(super) fn needs_address_bar(active_blocks: bool, pending_restores: usize) -> bool {
    active_blocks || pending_restores != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_does_not_query_but_expired_blocks_still_restore() {
        assert!(!needs_address_bar(false, 0));
        assert!(needs_address_bar(true, 0));
        assert!(needs_address_bar(false, 2));
        assert!(needs_address_bar(false, 1));
        assert!(!needs_address_bar(false, 0));
    }

    #[test]
    fn unlock_does_not_override_display_off_or_disconnection() {
        let mut activity = Activity::default();
        assert!(!activity.suspended());
        activity.locked = true;
        assert!(activity.suspended());
        activity.display_off = true;
        activity.locked = false;
        assert!(activity.suspended());
        activity.disconnected = true;
        activity.display_off = false;
        assert!(activity.suspended());
        activity.disconnected = false;
        assert!(!activity.suspended());
    }
}
