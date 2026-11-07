# Hosted feasibility results — 7 November 2026

## Final separated-PR comparison: all fourteen hosted jobs PASS

[Run 42402336061](https://github.com/digitalhabits/dh-blocker/actions/runs/42402336061)
validated source 6104cd2aea9c7f55474b0e011e0c235e895bee59 on 7 November 2026.
All seven scenarios passed on hosted macOS 15 and Windows Server 2025 x64:
recovery, pending cancellation, post-quit cancellation, overlap, unchanged stale
warning replay, natural schedule expiry/cold start, and paused/stopped restart.
All fourteen downloaded reports were independently checked for that source SHA
and behaviour, external GUI capability and exact-child cleanup PASS.

The new expiry cases prove acknowledged termination during the configured daily
window, release within ten seconds of its actual wall-clock end, 75 seconds of
usability, then another fresh Blocker process and 75 seconds of usability. The
schedule remains configured for its next daily window; this tests window end,
not deletion of the recurring rule. Saved times match the independent deadline.
The paused/stopped cases complete real 15-word challenges and retain both states
after process restart; no policy is cleared by the runner.

| Scenario | macOS Blocker PIDs | Windows Blocker PIDs | GUI checks per OS |
| --- | --- | --- | --- |
| Expiry / cold start | 4713 to 29280 | 5816 to 4612 | 9 |
| Paused / stopped restart | 3294 to 26583 | 1440 to 2472 | 8 |

Both phase reports, fixture state and logs were inspected. Final target/control
nonces, and the stopped secondary in restart cases, were independently matched
to saved-marker files on both OSes. Both final expiry screenshots were visually
inspected: the rule awaits its next daily window without a stale overlay.
Evidence is retained under artifacts/hosted-feasibility/evidence/42402336061/all/
and in Actions artifacts for 14 days. Earlier failed/cancelled attempts below
remain intact. Subsequent documentation commits do not change the tested source.

Local fixture ownership/protocol tests (6), focused warning-delivery tests (6),
scoped ESLint and diff checks passed. The initial sandbox helper test could not
create its symlink-escape fixture; it passed outside the filesystem sandbox.
No security setting changed and no local blocking test ran. GitHub frontend
build, lint, Tier 0, Tier 1, iOS timing and desktop Tier 2 checks also passed.

This remains hosted debug-WebDriver evidence. It does not establish signed
installed builds, upgrades, reboot/sleep, generic native callback faults, physical
iOS enforcement or three consecutive fresh qualification passes. The new tests
change no app code or native enforcement timer. No main push or merge occurred.



## Separate PRs and new lifecycle coverage

The app fix is isolated in [PR #244](https://github.com/digitalhabits/dh-blocker/pull/244),
branch `codex/fix-stale-warning`, commit `faeacaf7`, based on main.
Only warning delivery and its six focused tests are included. All six GitHub
checks passed, including the unsigned iOS build. No main push or merge occurred.
[PR #245](https://github.com/digitalhabits/dh-blocker/pull/245) is stacked on that
branch and contains only hosted tests, fixtures, workflow and documentation.
The original branch remains intact; its historical source-qualified results below
do not establish the new branch's lifecycle coverage.

First lifecycle attempt [42399596610](https://github.com/digitalhabits/dh-blocker/actions/runs/42399596610),
source `37d37756`: seven jobs passed, three failed and four were cancelled.
Both expiry cases used a five-minute window measured before several minutes of
UI setup. The macOS case reached activation after the window ended and never
received a warning; Windows explicitly failed the missed-window assertion.
The macOS restart case consumed its five-minute pause while configuring and
permanently stopping the second rule, and failed before restart because the
pause had expired. These are harness setup failures, not proven product lockouts.
Completed artifacts were downloaded before cancelling the superseded attempt to
release the workflow queue. Cancelled jobs do not count as passes. Evidence:
`artifacts/hosted-feasibility/evidence/42399596610/`.

The intermediate evidence-strengthening commit `ef92573b` queued run
42400249873, which GitHub cancelled while pending when the corrected commit
replaced it. It executed no scenarios. The correction `e85bd51d` uses a real
ten-minute finite schedule window and configures/stops the second rule before
starting the five-minute pause. The ten-second expiry release bound and real
challenges remain unchanged. PID observations require exactly one matching app
process and a different PID after restart. Phase reports, fixture state and logs
are copied before the next invocation can overwrite them.



Second attempt [42400755271](https://github.com/digitalhabits/dh-blocker/actions/runs/42400755271),
source e85bd51d: nine passes, one failure and four cancellations. macOS natural
schedule expiry plus cold start passed. Paused/stopped process restart passed
on both OSes (macOS PIDs 8549 to 29225; Windows 6784 to 8640), with both phase
reports retained. Final saved-marker nonces for target, secondary and control
were independently verified on both platforms. Windows expiry failed the new
saved-schedule assertion: it saved 18:00 instead of the requested 18:31. It was
not counted as expiry coverage. After downloading completed artifacts, the
superseded run was cancelled to release the queue. Evidence is retained under
artifacts/hosted-feasibility/evidence/42400755271/.

The next adapter uses actual pointer input on the visible hour/minute picker
instead of relying on text-field blur. It chooses five-minute increments and
verifies both visible and saved values, retaining the same independent deadline
and ten-second release bound. The selected end is 10–15 minutes after setup
begins, allowing measured UI transport time without modifying clocks or timers.


## Stale-warning fix: all ten hosted jobs PASS

[Actions run 42396442978](https://github.com/digitalhabits/dh-blocker/actions/runs/42396442978)
validated `60b76ae76d85b8d8c517fbf313019781140bedc7` on 7 November 2026.
Recovery, pending cancellation, post-quit grace cancellation, overlapping rules
and the **unchanged stale-callback replay regression** all passed on hosted
Windows Server 2025 x64 and macOS 15. Every report records behaviour, independent
external GUI capability and exact-child cleanup PASS.

Warning-show events now request the existing authoritative native pending-ACK
snapshot instead of installing their payload directly. Startup uses the same
path. Hide and acknowledgement invalidate in-flight reads; newer full snapshots
supersede older responses while retaining concurrent genuine warnings. Existing
rows are not replaced, preserving acknowledgement deadlines and snooze state.
Three read-only attempts handle transient query failures. On persistent failure,
existing UI remains and the error is logged; no unverified new row is installed,
no acknowledgement is fabricated, and native enforcement does not change.

The hosted test is byte-for-byte unchanged from the previously failing version.
Both replay events and exact original payloads appear in the new reports, after
the actual 15-word challenge and a successful external target GUI activation.
The replay no longer resurrects the released target's warning. Each case then
starts and acknowledges the secondary target, proves its termination, and keeps
the original released target plus unrelated control usable through at least
75 seconds. All five GUI-saved nonce checks per replay case passed. Final target
and control marker files were independently compared with their report nonces;
released targets have no polite-quit marker. The two post-replay screenshots were
visually inspected and show the target paused with no stale warning overlay.

Local verification: 258 Tier 0 tests (including six new warning-delivery race and
failure cases), 559 Tier 1 tests, production frontend build and repository ESLint
passed. ESLint excludes only ignored downloaded browser artifacts. The first
Tier 1 attempt could not find Chromium in the sandbox; a worktree-local browser
installation resolved that prerequisite. No local native blocking test ran.

Evidence is preserved under ignored
`artifacts/hosted-feasibility/evidence/42396442978/all/`, with Actions artifacts
retained for 14 days. The earlier failures in 42391230840 and 42392538195 below
remain intact and are not reclassified. The report-limit/source SHA identifies
the exact tested source; subsequent documentation commits do not change the fix.

The shared frontend change applies to desktop warning presentation on both
Windows and macOS; both were exercised. iOS Screen Time enforcement paths are
unchanged; local iOS logic checks passed within Tier 1, but physical iOS was not
verified. Signed-release external control, generic native stale PID/persistence
callbacks and three consecutive fresh qualification passes remain outside this
result. No real challenge, native timer, enforcement policy, security setting,
production data or release hard stop was weakened. Nothing merged.

## Historical failing stale-warning comparison
## Post-quit grace: PASS; stale warning callback: FAIL

[Final comparison 42392538195](https://github.com/digitalhabits/dh-blocker/actions/runs/42392538195)
validated `92cf6308` on hosted Windows Server 2025 x64 and macOS 15. Overall the
workflow remains **FAIL**: recovery, pre-quit cancellation, overlap and post-quit
cancellation pass on both platforms; stale-callback injection fails on both.
All ten GUI-capability verdicts and exact-child cleanups pass. The failing gate
is intentional evidence retention, not a skipped or quarantined case.

### Post-quit proof

Both targets recorded and declined the watcher's actual polite-close request.
The real 15-word challenge confirmed a ten-minute pause 139 ms after that marker
on macOS and 146 ms on Windows, within the unchanged ten-second native grace.
The original target PIDs survived the later secondary acknowledgement and at
least 75 seconds of observation. All five GUI saved-nonce checks per case passed;
the final target/control marker files were independently checked after download.
No fixture exception file was present.

The separately blocked stubborn secondary received its own real acknowledgement
and polite-close request, declined it and then exited 10.30 seconds later on
macOS (`SIGKILL`) and 10.12 seconds later on Windows (exit code 1). No cleanup
termination counts as this result. The exit callback was recorded before cleanup.
This positive control demonstrates the normal grace-to-force-kill path while the
released target remains usable.

### Reproduced stale warning regression

After a genuine warning callback was captured and normally delivered, the UI
completed the actual pause challenge and the target passed external AX/UIA
activation. Replaying the retained callback and original payload then re-added
an unacknowledged warning row for that released PID on both OSes. The test fails
at `assertNoTargetWarnings`; it never converts a heartbeat or GUI pass into a
behaviour pass. Screenshots, exact payloads and injection times are retained.

This is a **frontend warning-callback replay regression**, not proof of renewed
native enforcement or a killed released app: the failing scenario stops at the
renewed warning, before sustained post-injection observation. It does not cover
native stale PID entries, stale policy writes, schedules or arbitrary callback
interleavings. The owning warning-show listener in `src/blocking-platform.js`
unconditionally installs the received row; this test change does not repair or
change production policy. A targeted fix should reconcile delayed warnings with
current authoritative state and retain this failing regression as its oracle.

### Attempts and limits

| Attempt | Existing three cases, both OSes | Post-quit, both OSes | Stale callback, both OSes |
| --- | --- | --- | --- |
| [42391230840](https://github.com/digitalhabits/dh-blocker/actions/runs/42391230840), `98c901af` | PASS | FAIL | FAIL |
| [42392538195](https://github.com/digitalhabits/dh-blocker/actions/runs/42392538195), `92cf6308` | PASS | PASS | FAIL |

The first post-quit targets earned cancellation, but the secondary positive
controls exceeded the reused 45-second normal-quit budget. This was measured from
the pre-click WebDriver call, about five seconds before the real acknowledgement,
while stubborn fixtures must also survive ten seconds of post-quit grace. Those
failures remain preserved. The follow-up declares a distinct 55-second total
observation bound and 15 seconds from the actual close marker, and additionally
requires the exit callback 9–15 seconds after that marker, with no fixture error.
The primary cancellation phase remains strictly under ten seconds from the close
marker; ordinary 45-second termination tests and all production timers are unchanged.

All 20 attempted job cleanups passed. Complete evidence is retained under ignored
`artifacts/hosted-feasibility/evidence/42391230840/all/` and
`artifacts/hosted-feasibility/evidence/42392538195/all/`, plus Actions artifacts
with 14-day retention. Local fixture-only stubborn-close diagnostics passed
(`local-53508e3c2a6741eeaee81f62ab6244bf`), as did six safety/protocol tests and
full ESLint. No local blocking test was run.

No production frontend/enforcement code or security settings changed. Fault
injection exists only in the external hosted harness and operates the debug
WebDriver runtime; there is no new production endpoint. The report-limitation
text was subsequently updated as metadata only to identify the new scenario;
these downloaded reports remain verbatim. This is one passing post-quit attempt
per OS and an unresolved failing stale case, not three-run qualification or
signed-release, browser, consumer-Windows or physical-iOS coverage. Nothing merged.
## Pending cancellation and overlapping rules: PASS

[Actions run 42382988169](https://github.com/digitalhabits/dh-blocker/actions/runs/42382988169)
validated source `d12141b94b611d2614d881669cfb17d524fdbd29` on 7 November 2026.
All six fresh-VM jobs passed: recovery, pending and overlap on both Windows Server
2025 x64 and macOS 15. Every report records behaviour, external GUI capability and
exact-child cleanup PASS. Full artifacts are preserved under ignored
`artifacts/hosted-feasibility/evidence/42382988169/all/` and in Actions for 14 days.

- Pending: the actual 15-word challenge confirmed a ten-minute pause while the
  original target was in its acknowledged countdown. The click-time observation
  recorded 28,594 ms remaining on Windows and 28,362 ms on macOS. The original
  PID survived, with no polite-quit marker, through a later real acknowledgement
  and termination of a separately blocked secondary fixture. Target and unrelated
  control remained usable for at least 75 seconds after that acknowledgement.
- Overlap: A first enforced acknowledged termination. With A and B active for
  the same target, stopping A through the challenge left B on; B actually closed
  a relaunch. Completing B's challenge allowed relaunch. That released target
  survived the later secondary acknowledgement and 75-second observation.
- Each new case passed five independent GUI saved-nonce checks. Final target and
  control marker files were independently compared with report nonces after
  artifact download. Pending target polite-quit markers were confirmed absent.
  Both unchanged recovery cases passed their six GUI checks as well.

The embedded debug WebDriver reports its pointer events as `isTrusted=false`.
Input uses WebDriver actions/keys, never JS click or a stop/pause internal. The
read-only confirmation observer preserves that trust value and the countdown
snapshot. This is debug-WebDriver coverage; native external AX/UIA activates the
fixtures independently. It does not establish signed-release external Blocker UI
control. The subsequent metadata-only report update removes the old blanket
limitation saying pending/second-target cases are absent; downloaded reports are
preserved verbatim and their scenario events identify the exercised coverage.

### Every attempted comparison

| Run | Recovery, both OSes | Pending, both OSes | Overlap, both OSes |
| --- | --- | --- | --- |
| 42378613933 (`713065df`) | PASS | FAIL | FAIL |
| 42379815532 (`59e007d8`) | PASS | FAIL | PASS |
| 42381177273 (`8691074e`) | PASS | FAIL | PASS |
| 42382988169 (`d12141b9`) | PASS | PASS | PASS |

All 24 job cleanups passed. The first new cases assumed that launching into an
already-active rule would show a warning; the watcher intentionally closes such
launches immediately. Rules now start with the target already running. The next
pending failures exposed detached switch elements after card rerender. The third
reached confirmation during the countdown but failed an unsupported event-trust
assertion. That assertion was removed while preserving the observed trust value,
real challenge, phase, survival and GUI-marker requirements. Artifacts for all
failed attempts are retained under their run IDs; none counts as a passing case.

Six runner/protocol tests and full ESLint passed locally. No native blocking tests
ran locally; no production enforcement/frontend code, data or security settings
changed, and nothing was merged. The generic fixture builder adds one disposable
secondary app; macOS and Windows both exercised it. iOS was not run and its
production paths are unaffected.

This is one complete passing pending run per OS. Three consecutive fresh core
matrix qualifications, post-quit grace cancellation, later cancellation points,
explicit stale-callback injection, signed/installed releases, browser enforcement
and physical iOS remain outstanding. The overlap case covers removal of one of
two Manual blocklist sources, not every scheduled/allowlist overlap combination.

## Earlier Windows GUI activation result
## Current result: both hosted platforms PASS

[Actions run 42375075526](https://github.com/digitalhabits/dh-blocker/actions/runs/42375075526)
validated source `17c5abf3db4a7ae6276a78fd120f36f619b43988` on 7 November 2026.
Both macOS and Windows report **behaviour PASS, capability PASS, cleanup PASS**.

Windows passed all six external GUI activations through native
`IUIAutomationInvokePattern::Invoke`: target/control baseline, control during
blocking, target after pause, and both after at least 75 seconds. Every activation
persisted its fresh nonce through the real button handler. The final target and
control marker files were independently checked against their reported nonces;
the target's earlier saved marker also survived termination and relaunch.
All six native trees show an enabled Button with `save-marker` ID and InvokePattern.

The real warning, acknowledgement, termination, empty-challenge rejection,
15-word challenge and five-minute pause passed. Windows target termination was
observed at 35.78 seconds; post-pause responsiveness at 5.65 seconds. macOS values
were 36.07 seconds and 5.91 seconds. Both passed sustained release and exact-child
cleanup. The Windows fixture-only sharing-lock regression also passed, recording
three target and four control timer collisions before six successful GUI actions.
No `fixture-error.txt` was present in the Windows artifacts.

Runner images: Windows `20261103.298.1` (`win25-vs2026`, x64), macOS
`20261104.0514.1`. Debug app SHA-256:

- Windows: `ca4877c425de22ed8c039f88455223345d598aeaf4d80ba9f6a266a3b2509b32`
- macOS: `f39dd76c7ca2ba63ac25686cd4f3a91f6a5ef686eb53be2b17cdcf25ab13ed1c`

Complete artifacts are preserved locally under ignored
`artifacts/hosted-feasibility/evidence/42375075526/` and in Actions (14-day retention).
The earlier failed attempts below remain evidence: of the three new comparisons,
Windows failed twice for diagnosed fixture-protocol defects and passed once;
macOS passed all three. This is **one complete Windows feasibility pass**, not the
safety plan's three consecutive fresh qualification passes. Native fixture control
does not establish generic Windows application control, signed-release Blocker
control, browser enforcement, consumer Windows variants or physical iOS coverage.
No local blocking test, production-data change, security-setting change or merge
was performed. Future automation priorities remain pending-quit cancellation,
overlapping rules and stale persistence/callback recovery.

## Historical comparison before the native adapter

Previous comparison: [Actions run 42369161685](https://github.com/digitalhabits/dh-blocker/actions/runs/42369161685), source `ccfb0acff5fda2a8ccec9c5da17e49fc581f8aaa`.

| Evidence | macOS 15 | Windows Server 2025 |
| --- | --- | --- |
| Real UI creates and starts the target-only rule | PASS | PASS |
| Warning precedes acknowledgement; native target quits; control survives | PASS | PASS |
| Empty challenge rejected; actual 15-word challenge completed | PASS | PASS |
| Five-minute pause followed by target relaunch and event-loop response | PASS, about 5.93 s | PASS, about 5.64 s |
| Target/control respond through at least 75 s observation; no renewed warning observed | PASS | PASS |
| External GUI activation and saved marker survive target relaunch | PASS | BLOCKED |
| Exact-child cleanup | PASS | PASS |
| Overall job | PASS | Nonzero, BLOCKED capability |

Each sustained observation contained seven probe rounds. The one-second loop delay does not imply one-second sampling: WebDriver transport adds substantial overhead. These are sampled observations, not proof that no transient event occurred.

The macOS fixture buttons were activated through System Events/Accessibility at baseline, during the block and after release. Windows could activate the already foreground control using native Tab/Space, but reliably switching to the target failed. The script withheld keyboard input whenever the foreground PID differed from the intended fixture.

## What the comparisons established

- [Run 42367698801](https://github.com/digitalhabits/dh-blocker/actions/runs/42367698801), `70168545`: full macOS pass; Windows recovery passed, external activation remained blocked.
- [Run 42368980258](https://github.com/digitalhabits/dh-blocker/actions/runs/42368980258), `08a9c36b`: MTA threading did not resolve Windows activation.
- Final run `42369161685`, `ccfb0acf`: explicitly targeting .NET Framework 4.8 and disabling legacy accessibility switches also did not establish reliable target activation. The report records `net48-modern` and runtime-configuration hashes; this does not prove every intended provider feature was active.

Earlier attempts exposed harness assumptions about the removed `executeAsync` command, fresh-install onboarding, slider key defaults, menu scrolling and challenge-button disabling. Their failures remain in Actions history. The corrected test checks actual empty-challenge rejection and completes the normal challenge; it never calls stop/pause policy internals.

macOS image: `20261104.0514.1`. Windows image: `20261103.298.1` (`win25-vs2026`). Final blocker executable SHA-256 values:

- macOS: `f39dd76c7ca2ba63ac25686cd4f3a91f6a5ef686eb53be2b17cdcf25ab13ed1c`
- Windows: `7172e9bb91201dfb091695ba2492c32637607c9b66bffb2167427f6080c2ba8b`

## Decision and remaining gap

Hosted runners are demonstrably usable for the core debug app-block/recovery sequence on both platforms. A separate macOS/Windows machine is not a prerequisite for that coverage. Windows external GUI activation remains an adapter/session investigation; these results do not establish that buying hardware would fix it. A further Windows adapter should capture the accessibility tree, actual supported patterns, HWND ownership and desktop/focus state before selecting a provider or input strategy. Do not relax the saved-nonce requirement or report the current Windows job as green.

The probe uses an embedded-WebDriver debug build. It does not qualify signed-release external control of Blocker, real browser enforcement, consumer Windows variants, reboot/sleep, overlaps, pending-quit cancellation, fault injection or physical iOS. Repeated macOS feasibility successes are not the complete safety-plan qualification matrix.

Actions artefacts contain the JSON, native command logs, fixture state and screenshots, with 14-day retention. Copies of the final and MTA-only evidence were preserved locally under ignored `artifacts/hosted-feasibility/evidence/42369161685/` and `42368980258/`. No native blocking test was run against local personal applications. Automatic follow-up is stopped after recording this result; future platform experiments should be bounded and hypothesis-driven.

## Native Windows UIA investigation — 7 November 2026

Local fixture-only diagnostics reproduced the managed-wrapper failure: the exact
owned `WindowsForms10.BUTTON` HWND was reported as `ControlType.Pane`, with a
numeric automation ID, no patterns and `IsKeyboardFocusable=false`. Native HWND
inspection found only that button, ruling out selection of a same-named child.
Client and fixtures were in session 1, integrity RID 8192 (medium). Foreground
ownership differed on failed keyboard attempts; no input was sent to that PID.

Against the unchanged .NET 4.8 fixture, native `CUIAutomation` exposed the same
HWND as Button (50000), ID `save-marker`, with Invoke (10000) and LegacyIAccessible
(10018), using Microsoft's unmanaged MSAA proxy. Six fresh-nonce invocations
passed, with no foreground acquisition. This isolates the observed discrepancy
to the managed/native client-provider paths; it does not establish the precise
internal reason the managed proxy path failed.

The final bounded local diagnostic also passed heartbeat-only and wrong-title
negative cases and exact-child cleanup. Evidence remains under ignored
`artifacts/hosted-feasibility/local-1edddcdc90694934922bb152a92ec365/`;
the original failure tree is in `local-1f0ed810202c4823ad04086bcf53e8c9/`.
Earlier diagnostic development failures are retained beside these. No local
Blocker or blocking test was launched. Four safety-helper tests, scoped ESLint,
and native compilation with `/W4 /WX` passed. Hosted validation is pending.

Hosted attempt [42372743180](https://github.com/digitalhabits/dh-blocker/actions/runs/42372743180)
on `dee5e0c6` confirmed native InvokePattern and fresh saved nonces for both Windows
baseline fixtures. The run then failed during the termination observation on
`EBUSY` writing the control heartbeat request while WinForms held a read handle.
Capability and cleanup were PASS, behaviour FAIL; post-release GUI activation
was not reached. This failed attempt is retained under
`artifacts/hosted-feasibility/evidence/42372743180/windows/` and is not counted as
a full recovery pass.

The follow-up retries only EBUSY publication of the same nonce within the existing
four-second heartbeat deadline, recording collisions in `heartbeat-retries.jsonl`.
It does not retry GUI activation or extend release/termination budgets. A test
with the write seam added to the original algorithm reproduced the sharing error;
all six helper/protocol tests passed after the fix, including permanent-error and
stale-response rejection. The retry is shared by desktop probes; no production
frontend or enforcement code changes are involved.

Hosted attempt [42373629549](https://github.com/digitalhabits/dh-blocker/actions/runs/42373629549)
on `38fbe34f` passed macOS completely. Windows behaviour and cleanup passed,
including saved-state persistence and native target activation after pause and
75 seconds, but control activation failed twice with `0x80040200`
(`UIA_E_ELEMENTNOTENABLED`). The managed snapshots confirm the control's actual
window and button had become disabled. Overall Windows remained BLOCKED, not a
pass. Both platforms' full artifacts are retained under
`artifacts/hosted-feasibility/evidence/42373629549/`.

A deterministic local fixture-only test then held the request file exclusively
across timer ticks. With fail-fast exception logging added, the original timer
failed on `System.IO.IOException` in `File.InternalReadAllText`, reproducing the
reader-side sharing collision. Evidence: `local-73abfb80ed794d45a47bd216252746c1`.
This supports a WinForms exception-dialog explanation for the disabled hosted
control, though that attempt did not capture the dialog text itself.

The fixture now logs and defers only sharing/lock violations to the next 200 ms
tick; all other UI-thread exceptions log and exit rather than presenting a modal
dialog with a still-pumping timer. Native disabled-element failures are classified
FAIL rather than missing capability, and diagnostics include every owned top-level
window and native enabled state. The deterministic lock plus ten-second write
stress passed for both fixtures, followed by six real saved-nonce activations and
cleanup (`local-ffe259c803714edd8e1436aaf41b492e`). Windows CI now runs that explicit
fixture-only regression before the full recovery scenario. Full ESLint passed.
