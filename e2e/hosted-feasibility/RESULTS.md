# Hosted feasibility results — 7 November 2026

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

