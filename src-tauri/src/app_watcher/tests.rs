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
fn label_matches_a_name_carrying_an_invisible_direction_mark() {
    // macOS reports WhatsApp's process name with a leading U+200E. Left in, it
    // never equals the label the user picked: in allow mode that quits an app
    // they explicitly allowed, and in block mode it quietly blocks nothing.
    assert!(process_matches_app_label(
        "WhatsApp",
        "\u{200E}WhatsApp",
        None
    ));
    assert!(is_protected_app_name("\u{200E}Finder"));
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

// ---- allow mode: block start ------------------------------------

#[test]
fn an_allow_block_starting_arms_the_block_start_sweep() {
    // The watcher sees the transition in its own previous state: the
    // last policy had no allowlist, this one does. Nothing on the wire
    // ever says "newly started", so this is the only way the "save your
    // work" warning can fire for a manual or scheduled allow block.
    assert!(allowlist_block_started(false, false, true, false));
}

#[test]
fn an_unchanged_allow_policy_does_not_re_arm_the_sweep() {
    // The disk sync pushes the same policy every 2 s. Active→active must
    // stay quiet, otherwise the warning would be raised on every sync for
    // as long as the block runs.
    assert!(!allowlist_block_started(false, true, true, false));
    // Ending an allow block is not a start either.
    assert!(!allowlist_block_started(false, true, false, false));
    assert!(!allowlist_block_started(false, false, false, false));
}

#[test]
fn the_first_policy_after_start_is_baseline_not_a_transition() {
    // The app launched while an allow block was already running. Mirrors
    // the frontend's first-sync rule: what was open before we got here is
    // not something the user just did.
    assert!(!allowlist_block_started(true, false, true, false));
    assert!(!allowlist_block_started(true, false, false, false));
}

#[test]
fn the_explicit_newly_started_flag_still_arms_the_sweep() {
    // The wire contract is unchanged: a caller that says so is believed,
    // even when the derived state would not have counted it.
    assert!(allowlist_block_started(false, true, true, true));
    assert!(allowlist_block_started(true, false, true, true));
}

// ---- allow mode: things that must never be closed -----------------

#[test]
fn the_shared_windows_app_frame_is_never_a_target() {
    // Every Store-style app's window (Settings, Calculator, Photos…) belongs
    // to this one host process. Killing it closes all of them at once,
    // allowed apps included.
    assert!(is_protected_app_name("ApplicationFrameHost.exe"));
    assert!(is_protected_app_name("applicationframehost"));
}

#[test]
fn allow_mode_never_closes_an_installer_or_a_disk_operation() {
    use std::path::Path;
    // Interrupting these half-way can leave an install or a disk broken —
    // a cost out of all proportion to a focus block.
    let mac = [
        ("Installer", "/System/Library/CoreServices/Installer.app/Contents/MacOS/Installer"),
        ("Disk Utility", "/System/Applications/Utilities/Disk Utility.app/Contents/MacOS/Disk Utility"),
        (
            "Migration Assistant",
            "/System/Applications/Utilities/Migration Assistant.app/Contents/MacOS/Migration Assistant",
        ),
    ];
    for (name, exe) in mac {
        assert!(
            is_allow_mode_exempt(name, Some(Path::new(exe))),
            "{name} must be exempt"
        );
    }
    for name in ["msiexec.exe", "MSIEXEC.EXE", "wusa.exe"] {
        assert!(is_allow_mode_exempt(name, None), "{name} must be exempt");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn the_installer_is_exempt_under_a_localised_name() {
    use std::path::Path;
    // NSRunningApplication reports the *localised* name — "Installer" is
    // "Installationsprogram" in Danish — so the bundle path has to decide.
    assert!(is_allow_mode_exempt(
        "Installationsprogram",
        Some(Path::new("/System/Library/CoreServices/Installer.app")),
    ));
}

#[test]
fn allow_mode_exemption_does_not_swallow_ordinary_apps() {
    use std::path::Path;
    // Over-broad exemption is a silent hole in the block.
    for (name, exe) in [
        ("Safari", "/Applications/Safari.app/Contents/MacOS/Safari"),
        ("Slack", "/Applications/Slack.app/Contents/MacOS/Slack"),
        (
            "chrome.exe",
            "C:\\Program Files\\Google\\Chrome\\chrome.exe",
        ),
        (
            "Disk Utility Pro",
            "/Applications/Disk Utility Pro.app/Contents/MacOS/x",
        ),
    ] {
        assert!(
            !is_allow_mode_exempt(name, Some(Path::new(exe))),
            "{name} must not be exempt"
        );
    }
}

#[test]
fn the_exe_suffix_is_dropped_whatever_its_case() {
    assert_eq!(strip_exe_suffix("notepad.exe"), "notepad");
    assert_eq!(strip_exe_suffix("NOTEPAD.EXE"), "NOTEPAD");
    assert_eq!(strip_exe_suffix("Safari"), "Safari");
    assert_eq!(strip_exe_suffix(".exe"), "");
    assert_eq!(strip_exe_suffix("exe"), "exe");
    // Multi-byte names must not be split inside a character.
    assert_eq!(strip_exe_suffix("日本語"), "日本語");
    // A user's label matches the process however Windows cases it.
    assert!(process_matches_app_label("notepad", "NOTEPAD.EXE", None));
}
