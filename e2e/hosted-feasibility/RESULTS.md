# Hosted feasibility results — 7 November 2026

Final comparison: [Actions run 42369161685](https://github.com/digitalhabits/dh-blocker/actions/runs/42369161685), source `ccfb0acff5fda2a8ccec9c5da17e49fc581f8aaa`.

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
