# Hosted recovery feasibility

This opt-in workflow asks whether fresh GitHub-hosted `macos-15` and
`windows-2025` VMs can exercise a real desktop app-blocking and recovery cycle.
It changes no enforcement policy. `run.js` refuses native runs unless
`GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted` and macOS/Windows are
all present. Do not set those variables to run this on a personal machine.

The workflow initially runs on pushes to `codex/hosted-recovery-feasibility` and
supports `workflow_dispatch`. A new workflow needs its first branch push before
it is available on the default branch for normal dispatch discovery. Each OS
runs independently, with a 40-minute job deadline and evidence uploaded even on
failure. There are no automatic scenario retries.

## What runs

1. Refuse existing `com.reddblock/redd-block-data.json`, and require the loaded
   app to contain no focus spaces, schedules or active blocks. The disposable VM
   account is the isolation boundary for the app's ordinary desktop profile.
   Cargo output and Node dependencies stay in the checked-out worktree.
2. Compile native AppKit or WinForms GUI fixtures into a random run directory.
   Target and control have distinct run-specific executable names, exact child
   PIDs and window titles. Neither is installed into a real application folder.
3. Prove both event loops answer fresh nonce requests, then independently press
   each real **Save marker** button through macOS System Events/Accessibility or
   Windows UIAutomation `InvokePattern`. The button persists the nonce marker.
4. Use the visible Blocker UI to create a Manual focus space, select only the
   target through **Add App → Add … anyway**, and configure a one-word challenge
   using the normal range slider. Turn it on and accept its start confirmation.
5. Observe the target's warning and continued liveness before acknowledging
   **Let's go!**. Observe actual target termination after the normal 30-second
   pre-quit interval, within a 45-second total budget, including its polite-close
   marker. Keep the original control PID alive and responsive throughout.
6. Turn off that space through its switch, select a five-minute pause, type the
   real displayed challenge with WebDriver key events and confirm normally.
   Relaunch the target, check saved state and a fresh event-loop response within
   the proposed ten-second release budget, and independently press its button.
7. For at least 75 further seconds, sample target warnings and both nonce
   responses approximately once a second. Press both GUI buttons again and
   preserve screenshots before exact-child cleanup.

The existing `acceptEula()` seam is used for setup only. All rule creation,
start, acknowledgement and release use visible UI input. Read-only internals
provide initial-policy and warning diagnostics; neither diagnostics nor a
successful pause command is the native release oracle.

## Verdicts and evidence

`report.json` records the source SHA, debug executable SHA-256, actual runner
image/OS, expected timing bounds, monotonic elapsed timings, wall times, exact
fixture identities, interactions and separate behaviour, capability and cleanup
verdicts. It does not dump environment variables or credentials. Native command
output, per-fixture state/logs, WDIO logs and webview screenshots accompany it.

A missing external GUI capability is **BLOCKED**, with the actual System Events
or UIAutomation error retained. Heartbeat success cannot substitute for external
GUI access. A successful GUI invocation without the expected saved nonce is
**FAIL**. Behavioural or cleanup failures also fail the workflow. Every missing
prerequisite or unfinished scenario remains nonzero, never a skipped green run.
The behavioural verdict is captured before cleanup; cleanup cannot count as a
successful user release. Cleanup terminates only children spawned by this run;
it does not clear policy, stop other applications or delete user data. The VM
and its five-minute paused Manual space are discarded after the job.

## Evidence limits

The Blocker build is the same ordinary debug `e2e-webdriver` build used by Tier 2.
Embedded WebDriver operates the Blocker webview; the independent AX/UIAutomation
probe operates the native fixtures. A pass establishes hosted debug feasibility,
not signed release installation, external control of Blocker's UI, release TCC
behaviour, real browser enforcement, iOS shielding or physical-device support.
No permissions database is edited and no security protection is disabled.

This initial probe covers acknowledged termination followed by a legitimate
pause and sustained relaunch. It does not yet cover cancellation during pending
quit, a later second-target acknowledgement, injected stale callbacks, faults,
restart/update, natural expiry or overlaps. Three consecutive fresh qualified
runs are still required by [the safety plan](../../docs/lockout-safety-plan.md);
one feasibility pass is not a release gate.

Pure safety-helper tests can run locally without launching any native process:

```sh
node --test e2e/hosted-feasibility/helpers.test.js
node_modules/.bin/eslint e2e/hosted-feasibility
```
