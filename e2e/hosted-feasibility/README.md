# Hosted recovery feasibility

Recorded outcomes and remaining gaps: [experiment results](RESULTS.md).

This opt-in workflow asks whether fresh GitHub-hosted `macos-15` and
`windows-2025` VMs can exercise a real desktop app-blocking and recovery cycle.
It changes no enforcement policy. `run.js` refuses native runs unless
`GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted` and macOS/Windows are
all present. Do not set those variables to run this on a personal machine.

The workflow initially runs on pushes to `codex/hosted-recovery-feasibility` and
supports `workflow_dispatch`. The branch push starts this initial experiment; normal manual-dispatch discovery
requires the workflow file to exist on the default branch. Each OS
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
   native Windows `IUIAutomationInvokePattern::Invoke`. The button persists the nonce marker; the report names the actual activation method.
4. Use the visible Blocker UI to create a Manual focus space, select only the
   target through **Add App → Add … anyway**, and keep its ordinary 15-word challenge. Turn it on and accept its start confirmation.
5. Observe the target's warning and continued liveness before acknowledging
   **Let's go!**. Observe actual target termination after the normal 30-second
   pre-quit interval, within a 45-second total budget, including its polite-close
   marker. Keep the original control PID alive and responsive throughout.
6. Turn off that space through its switch, select a five-minute pause, type the
   real displayed challenge with WebDriver key events and confirm normally.
   Relaunch the target, check saved state and a fresh event-loop response within
   the proposed ten-second release budget, and independently press its button.
7. For at least 75 further seconds, sample target warnings and both nonce
   responses periodically with a one-second minimum delay. The report timestamps
   expose the actual cadence, including WebDriver transport overhead. Press both GUI buttons again and
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
node --test e2e/hosted-feasibility/helpers.test.js e2e/hosted-feasibility/native.test.js
node_modules/.bin/eslint e2e/hosted-feasibility
```

The initial runs exposed embedded-driver limitations: `executeAsync` is absent,
Home does not implement a range slider’s native default action, and element-click
scrolling can dismiss a custom menu. Setup uses the established completion poll,
the probe completes the full default challenge, and menus use pointer actions
after a visible hit-test. No policy or challenge-completion internal is called.
The 15-minute scenario timeout accommodates this slow transport; native release,
pre-quit and sustained-observation bounds remain unchanged.

Windows uses a small C++ client of the OS's native `IUIAutomation` interface,
compiled with the installed Visual C++/Windows SDK into the run directory.
It validates the exact window title, PID, child HWND ownership, Button type and
`save-marker` automation ID before invoking. No foreground acquisition or keyboard
fallback is needed. Managed and native trees, native provider descriptions,
supported patterns, foreground HWND/PID, session and integrity levels are retained.
The old managed adapter remains only for diagnostic comparisons.

For local investigation, run the explicit fixture-only entry point:

```powershell
powershell.exe -NoProfile -File e2e/hosted-feasibility/diagnose-windows-fixtures.ps1
# Reproduce the old managed adapter without changing the hosted path:
powershell.exe -NoProfile -File e2e/hosted-feasibility/diagnose-windows-fixtures.ps1 -ManagedBaseline
# Exercise both sides of the heartbeat file-sharing race (also runs in Windows CI):
powershell.exe -NoProfile -File e2e/hosted-feasibility/diagnose-windows-fixtures.ps1 -StressHeartbeat
```

This builds and opens only the two disposable fixtures, checks heartbeat-only
and wrong-title negative cases, invokes each button three times with new nonces,
and cleans up its exact children. Adapter processes have a 12-second deadline.
It never launches Blocker or touches its profile; hosted-only guards are unchanged.
Logs and binaries remain under `artifacts/hosted-feasibility/local-*`. A failed
attempt remains preserved and nonzero. Visual C++ and .NET Framework are required.
The stress variant holds the request file exclusively across multiple timer ticks,
then checks responsiveness and real GUI activation. Timer sharing/lock violations
are logged and deferred to the next tick; other UI-thread exceptions persist an
error and terminate the fixture instead of opening a disabling WinForms dialog.
Client-side EBUSY writes retry the same nonce within the original four-second
budget. Neither side fabricates a response or retries a GUI invocation.

The current Windows fixture explicitly targets .NET Framework 4.8 and opts into
its modern accessibility behaviour through its executable configuration. The
report records `net48-modern` and hashes the binary and runtime configuration.
This follows [Microsoft’s accessibility configuration](https://learn.microsoft.com/en-us/dotnet/framework/migration-guide/retargeting/4.8.x).
Prior legacy-provider focus failures remain evidence for that fixture profile;
a modern-profile pass must not be presented as proof of generic foreground
control or all legacy application providers.

## Pending cancellation and overlap scenarios

The workflow runs `recovery`, `pending` and `overlap` in separate fresh hosted VMs
on each OS. Rules are created inactive, fixtures launched, then rules started
through their visible switches. Launching into an already-active rule intentionally
uses immediate close instead of the block-start warning; the first attempt
incorrectly assumed otherwise and remains preserved in Actions history.

Pending cancellation acknowledges the warning, opens the stop dialog, types the
actual 15-word challenge and confirms the ordinary ten-minute pause through real
WebDriver pointer/key input. A read-only click observer records the exact PID's
acknowledged deadline at confirmation. Missing the 30-second phase fails the case;
the original PID must survive without a polite-quit marker. No timer is extended.

Overlap starts source A and proves acknowledged termination. It then starts B,
stops A through the real challenge, and verifies relaunch is still closed by B.
After completing B's challenge it relaunches the released target. Both overlap
stops use Never to prevent automatic resumption during the longer scenario.

Both cases subsequently launch a separate secondary fixture, start its rule and
acknowledge its warning. That process must actually terminate while the released
target and unrelated control survive for at least 75 seconds, with fresh GUI-saved
nonces afterward. All names and children are run-owned. Native deadlines and
cleanup rules are unchanged. The scenario transport timeout is 30 minutes.
Post-quit grace cancellation, injected stale callbacks and three-pass qualification
remain separate coverage. No local blocking run is used.

## Post-quit grace and stale callback cases

`postquit` uses a disposable stubborn fixture: it records the real polite-close
request and declines it while keeping its event loop and GUI usable. The harness
prepares the ordinary 15-word challenge, waits for the close marker, then confirms
the ten-minute pause. Confirmation must occur after the acknowledged pre-quit
deadline and within ten seconds of the actual close marker. The same PID must
survive. A later independently blocked stubborn secondary fixture must terminate,
proving force-kill enforcement remains observable while the released target and
control survive the subsequent 75-second observation. No grace timer is extended.

`stale` captures the actual registered frontend Tauri warning-show callback when
its genuine event is delivered, without suppressing normal delivery. After the
real challenge earns release, it replays that retained callback and payload. A
renewed target warning fails immediately, with a screenshot and injection record.
This is explicitly runtime fault injection in the debug-WebDriver build, not a
signed-release result. It does not simulate a native PID state reinsertion or
prove all stale persistence/schedule/callback combinations. No production test
endpoint or app-code hook is added. Failures stay non-green and retained.

Fixture-only Windows stubborn-close diagnostics can run without Blocker:
`powershell.exe -NoProfile -File e2e/hosted-feasibility/diagnose-windows-fixtures.ps1 -Stubborn`.

The stubborn secondary's positive-control observation has a separate 55-second
total bound from the pre-click driver call and a 15-second observation bound from
its close marker (ten-second native grace plus sampling/dispatch allowance).
Its actual exit callback must be 9–15 seconds after that marker; fixture exceptions
cannot satisfy it. The normal fixture's 45-second polite-termination budget and
the primary target's exact ten-second cancellation phase are unchanged. The first
macOS attempt using the normal 45-second budget for this distinct force-kill case
is retained as a failure, not retrospectively converted to PASS.

## Stale warning delivery fix

Warning-show events now trigger a read of the watcher's current pending-ACK
snapshot; their payloads cannot directly create UI rows. Startup uses the same
path. Hide/ack transitions invalidate in-flight reads, and newest snapshots retain
all concurrent genuine warnings without resetting existing countdown/snooze rows.
Read-only verification retries at most three times. If it still fails, existing
visible warnings remain, unverified new rows are not created, and the error is
logged. Native enforcement is unchanged and nothing auto-acknowledges a warning.
The hosted stale replay regression is unchanged; it must proceed through the
later second-target acknowledgement, sustained survival and external GUI checks.
