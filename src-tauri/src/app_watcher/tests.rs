use super::*;

// The watcher's two dangerous behaviours are "force-quits the wrong
// process" and "force-quits the right process too early". Both are
// decided by pure functions — the protection list, the label matcher,
// and the phase machine — so they are asserted here directly.
//
// Not covered at this layer: `sweep` itself, which needs a live
// `sysinfo::Process` to enrol a PID and to call `kill()`. The enrolment
// rules (warning-eligible first sighting vs. silent mid-block PostQuit)
// stay with the manual checklist.

// ---- protection list --------------------------------------------

#[test]
fn protected_names_are_never_targets() {
    // Quitting any of these would either kill the blocker itself —
    // the one process that must survive to keep enforcing — or take
    // the desktop down with it.
    for name in [
        "Digital Habits Blocker",
        "Digital Habits: Blocker",
        "ReDD Blocker",
        "redd-block",
        "Finder",
        "loginwindow",
        "WindowServer",
        "explorer.exe",
        "dwm.exe",
        "winlogon.exe",
    ] {
        assert!(is_protected_app_name(name), "{name} must be protected");
    }
}

#[test]
fn protection_ignores_case_and_the_exe_suffix() {
    assert!(is_protected_app_name("finder"));
    assert!(is_protected_app_name("FINDER"));
    assert!(is_protected_app_name("EXPLORER.EXE"));
    // "Taskmgr" is listed without a suffix; the Windows process carries one.
    assert!(is_protected_app_name("Taskmgr.exe"));
    assert!(is_protected_app_name("Task Manager"));
}

#[test]
fn ordinary_apps_are_not_protected() {
    // An over-broad protection rule silently exempts apps the user
    // asked to block, which reads as "blocking is broken".
    for name in [
        "Safari",
        "Slack",
        "Microsoft Word",
        "Finder Helper",
        "MyWindowServerThing",
        "chrome.exe",
    ] {
        assert!(!is_protected_app_name(name), "{name} must not be protected");
    }
}

// ---- label matching ---------------------------------------------

#[test]
fn label_matches_process_name_case_insensitively() {
    assert!(process_matches_app_label("Slack", "Slack", None));
    assert!(process_matches_app_label("slack", "Slack", None));
    assert!(process_matches_app_label("Chrome", "chrome.exe", None));
}

#[test]
fn label_does_not_match_a_different_app_with_a_shared_prefix() {
    // Substring matching here would quit apps the user never listed.
    assert!(!process_matches_app_label("Slack", "Slackbot", None));
    assert!(!process_matches_app_label("Code", "Codex", None));
    assert!(!process_matches_app_label("Mail", "Mailspring", None));
}

#[cfg(target_os = "macos")]
#[test]
fn label_matches_the_bundle_directory_when_the_executable_differs() {
    // sysinfo reports the bundle executable ("studio"), the user's list
    // holds the bundle name ("Android Studio") — without the path check
    // the app is simply never matched and never blocked.
    let exe = std::path::Path::new("/Applications/Android Studio.app/Contents/MacOS/studio");
    assert!(process_matches_app_label(
        "Android Studio",
        "studio",
        Some(exe)
    ));
    assert!(!process_matches_app_label("Xcode", "studio", Some(exe)));
}

#[cfg(target_os = "macos")]
#[test]
fn bundle_path_match_does_not_fire_on_a_longer_bundle_name() {
    let exe = std::path::Path::new("/Applications/Codex.app/Contents/MacOS/Codex");
    assert!(!process_matches_app_label("Code", "Codex", Some(exe)));
}

#[test]
fn allow_check_spans_the_whole_allowed_list() {
    let allowed = vec!["Safari".to_string(), "Notes".to_string()];
    assert!(process_is_allowed(&allowed, "Notes", None));
    assert!(!process_is_allowed(&allowed, "Slack", None));
    assert!(!process_is_allowed(&[], "Notes", None));
}

// ---- phase machine ----------------------------------------------

#[test]
fn awaiting_ack_never_advances_on_its_own() {
    // The Let's go overlay must wait for the user however long it takes;
    // an elapsed timer here would quit an app with no warning shown.
    let now = Instant::now();
    assert_eq!(
        next_pid_step(&PidPhase::AwaitingUserAck, now),
        PidStep::Hold
    );
    assert_eq!(
        next_pid_step(&PidPhase::AwaitingUserAck, now + Duration::from_secs(3600)),
        PidStep::Hold
    );
}

#[test]
fn prequit_holds_until_its_deadline_then_asks_for_a_polite_quit() {
    let now = Instant::now();
    let phase = PidPhase::PreQuit {
        quit_at: now + PREQUIT_DURATION,
    };
    assert_eq!(next_pid_step(&phase, now), PidStep::Hold);
    assert_eq!(
        next_pid_step(&phase, now + PREQUIT_DURATION - Duration::from_millis(1)),
        PidStep::Hold
    );
    // The deadline itself fires — `now < quit_at` is the hold condition.
    assert_eq!(
        next_pid_step(&phase, now + PREQUIT_DURATION),
        PidStep::RequestQuit
    );
}

#[test]
fn postquit_holds_through_the_grace_then_force_kills() {
    let now = Instant::now();
    let phase = PidPhase::PostQuit {
        kill_at: now + POSTQUIT_GRACE,
    };
    assert_eq!(next_pid_step(&phase, now), PidStep::Hold);
    assert_eq!(
        next_pid_step(&phase, now + POSTQUIT_GRACE - Duration::from_millis(1)),
        PidStep::Hold
    );
    assert_eq!(
        next_pid_step(&phase, now + POSTQUIT_GRACE),
        PidStep::ForceKill
    );
}

#[test]
fn the_full_sequence_gives_the_user_both_grace_windows() {
    // Walk warn -> polite quit -> SIGKILL the way a sweep would, and
    // check nothing escalates early. Shortening either window is a
    // user-visible regression (an app killed mid-save).
    let start = Instant::now();
    // User clicks "Let's go!" — `sweep` performs this transition.
    let mut phase = PidPhase::PreQuit {
        quit_at: start + PREQUIT_DURATION,
    };

    let mut t = start;
    while t < start + PREQUIT_DURATION {
        assert_eq!(
            next_pid_step(&phase, t),
            PidStep::Hold,
            "early quit at {t:?}"
        );
        t += Duration::from_secs(1);
    }
    let quit_at = start + PREQUIT_DURATION;
    assert_eq!(next_pid_step(&phase, quit_at), PidStep::RequestQuit);

    phase = PidPhase::PostQuit {
        kill_at: quit_at + POSTQUIT_GRACE,
    };
    let mut t = quit_at;
    while t < quit_at + POSTQUIT_GRACE {
        assert_eq!(
            next_pid_step(&phase, t),
            PidStep::Hold,
            "early kill at {t:?}"
        );
        t += Duration::from_secs(1);
    }
    assert_eq!(
        next_pid_step(&phase, quit_at + POSTQUIT_GRACE),
        PidStep::ForceKill
    );
}

#[test]
fn grace_windows_are_long_enough_to_be_usable() {
    // Guards against a zero/near-zero constant slipping in: the whole
    // point of the state machine is that the user gets time to save.
    assert!(PREQUIT_DURATION >= Duration::from_secs(10));
    assert!(POSTQUIT_GRACE >= Duration::from_secs(5));
}

// ---- mid-block sightings ----------------------------------------

#[test]
fn a_blocked_app_opened_mid_block_is_quit_without_ceremony() {
    // Blocklist mode: the user was warned when the block started and has
    // now deliberately launched something on the list.
    assert_eq!(
        mid_block_sighting_quit(EntryOrigin::Blocklist),
        SightingQuit::Silent
    );
}

#[test]
fn an_allow_mode_sighting_gets_the_polite_quit_so_work_can_be_saved() {
    // Allow mode: the trigger is any non-allowed app coming to the front —
    // one that was hidden when the block started, or one that raised itself.
    // Nobody chose to open it, and it may hold unsaved work, so it must get
    // the quit that runs the app's own "save changes?" path, never a signal
    // that skips it.
    assert_eq!(
        mid_block_sighting_quit(EntryOrigin::Allowlist),
        SightingQuit::Polite
    );
}
