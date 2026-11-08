# Preventing unintended lockout: implementation plan

Status: bounded hosted desktop recovery and installed debug-upgrade infrastructure is implemented; source-qualified outcomes and remaining gaps live in [hosted results](../e2e/hosted-feasibility/RESULTS.md). The baseline audit below is historical, not a current coverage inventory. Product decisions below remain prerequisites for enforcement-policy changes. Implementation and device installation are not authorised by this plan alone.
Source baseline: `59a76211`, including the connected-iOS pause profile from `4291ba13`.

## Objective and boundaries

Prevent our mistakes from blocking the wrong target, extending a restriction beyond the user's chosen terms, or leaving a user unable to regain access after a legitimate stop, pause or expiry. Treat a demonstrated unintended lockout as release-blocking. No test programme can prove absence of every failure.

Preserve intentional friction: complete the real configured challenge, keep enforcement opt-in where specified, and do not add a free quit/unblock route. Timed and indefinite Manual rules have different contracts; never impose automatic expiry on an intentionally indefinite rule as an incidental testing change.

This plan first makes existing behaviour observable and repeatable. Changes to failure policy, persistence or recovery architecture are separate, reviewed fixes justified by a failing safety case. Do not redesign all enforcement backends together.

## Current evidence and gaps

| Platform/layer | Reuse | Gap this plan closes |
| --- | --- | --- |
| Shared frontend | Tier 0/1, Tier 2, UI fixtures and measurements | Native release is not established by a flag, successful command or screenshot alone. |
| macOS | `scripts/run-system-test-macos.mjs`, Safari/Brave suites, disposable app fixture | The current app recovery case removes policy without acknowledging the warning: survival cannot prove cancellation of a pending quit. Treat it as non-evidence for recovery until replaced. Add the full UI lifecycle and proof that a reopened app stays usable. |
| Windows | Native Tier 2 in CI, UIA probe, MSIX staging checks | Add a real process and browser lifecycle suite. A test package's different identity does not isolate data or native messaging. |
| iOS | External XCTest `website` and scheduled `pause` profiles | Add app-shield release, native picker, timed Manual, overlapping-rule and recovery coverage. Simulator and compile checks do not establish Screen Time enforcement. |
| Delivery | Path-filtered workflows and local system runners | Critical application changes can miss Tier 2; real-system results are not a complete release gate. |

Owning references: [testing](../testing.md), [iOS protocol](ios-testing.md), [Windows packaging](windows-test-build.md), [physical/manual cases](../scripts/manual-test-checklist.md).

## Required decisions before expanding destructive tests

Build a reviewed failure-policy register in PR 1a. The following entries are grounded in the current source; the remaining release routes have **not** been proven by this audit. Each entry must identify user-authorised intent, detector uncertainty, the affected scope, failure direction, an accessible recovery route and a reproducing test.

| Existing decision | Evidence | Required decision/test |
| --- | --- | --- |
| Refuse an iOS timed pause if restart registration fails | `src/confirm-modals.js`, `stopFocusSpaceTarget` | After the legitimate challenge, prove a usable release alternative under the same fault. Consider an explicitly chosen permanent stop; do not silently convert timed intent into Never or demand an impossible additional challenge. The fallback must survive app restart and clear the relevant native restrictions. |
| Trim iOS allowlist exceptions on automatic resume | `architecture.md` §12.3 and Swift policy appliers | Reproduce both app-token and website-exception cap overflow on resume and identify which allowed targets become blocked. Decide a non-locking recovery and truthful error policy before calling this safe; do not bless over-blocking merely because it is existing behaviour. |
| Quit an opted-in browser after failed compliance detection | `src-tauri/src/enforcer.rs` | Define which profile/browser identity determines compliance. Test missing or unreadable profiles, multiple/non-default profiles, channels and upgrades. A compliant browser must not be closed because an unrelated profile was inspected; with enforcement off and no independent app rule, no compliance-related quit is allowed. |
| Exclude System Settings and Activity Monitor from some protections | `src-tauri/src/app_watcher.rs`, protection lists | Identify the minimum controls needed for an authorised release/recovery, including when the app is unhealthy. Resolve conflicts with bypass prevention explicitly; do not assume all system apps are protected. |
| Empty desktop app policy when persisted data cannot be read | `src-tauri/src/native_host.rs`, `derive_blocked_apps` | Record this existing release-direction choice and verify behaviour under missing/corrupt data; do not silently replace it with an indefinite last-known restriction. |

Audit the register for completeness by tracing error/fallback branches and searching fail-safe, over-blocking and truncation comments, including both app and website allowlists. Each register entry becomes a required safety-matrix row with a named owner; a missing test or working route is a release-blocking gap.

A visible error alone does not satisfy the safety objective. If the normal stop/pause fails after a completed challenge, at least one explicit, bounded and usable recovery route must remain. A test must exercise that route under the injected failure. The product owner must decide the intent trade-off of any alternative before implementation. An acknowledged risk without a tested route cannot count as safety-verified.

## Writers, transition mechanisms and reconciliation

The following is the starting actor map, not a claim that reconciliation is already correct:

| Transition | Writers/mechanism | Failure and recovery case |
| --- | --- | --- |
| Desktop app policy | Frontend command/tick; save-triggered Rust sync; independent 2 s disk loop; watcher phase timers | Failed save followed by old disk policy; a stale frontend policy arriving after a newer disk policy; stop during pre-quit/force-kill grace. Clear acknowledgements alone are insufficient because the disk loop can re-create the watcher. |
| Desktop expiry | Rust time-based derivation while the app runs; frontend tick also participates | Verify release with the webview backgrounded, then restart after expiry. A terminated desktop app cannot kill targets; cold start must not resurrect expired rules. |
| iOS manual and scheduled shields | App plus DeviceActivity extension; separate manual/scheduled stores and a merged manual record | Shared-token overlap, one source ending while another remains, and final-source removal; verify actual shields as well as each store's derivation. |
| iOS timed pause | App clears/applies policy; captured resume payload and one-off OS callback restore it | Registration failure; edits during a pause if permitted; stale payload or duplicate/delayed resume; callback loss causing missed reblock. |
| iOS scheduled end | DeviceActivity end/warning callbacks, including minimum-length padded intervals | Missed/delayed end callbacks and app reopening after deadline. Prove a foreground/cold-start reconciliation backstop rather than assuming one exists. |

Early deterministic work must treat these as separate actors. Use explicit timestamps and an independent oracle to compare shared semantics across JS, Rust and Swift; normalise documented platform differences such as token limits. Add clock seams beneath pure derivations, keeping production wrappers on the real clock. Audit and enforce parity of the two current `ScheduleData.swift` copies (or documented generated regions), since CI presently compiles both through different scripts. Do not force platform-specific representations to be identical.

Include these interleavings: save failure then disk refresh; old UI command after new durable intent; start/edit/stop around native apply; edit while paused then old resume delivery; two Manual sources sharing tokens followed by one source ending. Eligibility for editing during pause must be established from the real UI first. Preserve seed, operation trace and expected/observed policy for every failure.

## Safety contracts and the external oracle

Each scenario declares intended targets, control targets, rule IDs, schedule, duration, expected state transitions and permitted changes before execution. Assert:

1. Only intended targets are restricted; an unrelated control app/site remains usable during every transition.
2. Required warning/grace intervals are honoured before closing apps. Use a disposable fixture with a saved-state marker to detect premature termination or lost test data.
3. A completed, accepted pause/stop releases the target within a stated deadline, unless another active rule still requires blocking. Natural expiry releases without reopening the main app.
4. Reopening the target after release works and it stays usable through multiple enforcement scans. A delayed old callback cannot reapply a removed rule. Resume reblocks only when explicitly requested or the agreed pause ends.
5. Overlaps retain remaining restrictions; removing one source neither clears another source nor leaves an orphan restriction after the last source ends.
6. The blocker and the controls needed to complete the legitimate stopping challenge remain usable. A clear UI status cannot conceal a failed native release.
7. Restart, update and recovery preserve user intent, including already paused, stopped and expired states. They must not turn a finite rule into an indefinite rule.

Observe independently: target process liveness plus an interactive heartbeat/saved marker; loaded browser content and target host plus a control page; physical iOS shield disappearance followed by successful target interaction. Diagnostics and persisted data explain failures but are not the pass oracle. Keep time-stamped evidence from before cleanup.

Initial proposed release budgets: desktop within 10 seconds; physical iOS direct action within 30 seconds; iOS schedule callback within 60 seconds. These are proposed user-facing bounds, not current OS guarantees. The feasibility phase records timing and agrees fixed support-specific bounds before gating. A missed background deadline is still a failed background case even if reopening later repairs it. The proposed foreground backstop is release within 10 seconds of reopening after expiry. If an OS cannot meet a background bound, explicitly decide whether to narrow the advertised guarantee/support or change the design; record the exception and require a tested backstop. Do not silently widen deadlines or label a weaker result equivalent.

For desktop pending-quit cases, observe survival for at least 75 seconds after release: the current 30 s pre-quit window plus 10 s post-quit grace plus two 15 s safety-net sweeps and margin. Derive the minimum again if those constants change. This interval must include continued interaction and absence of any new warning/overlay for the released target, not just a surviving PID. Add a second, separately blocked fixture, acknowledge its real “Let’s go” warning and prove the released target remains unaffected. This exercises the shared acknowledgement latch and exposes stale enrolment that would otherwise wait indefinitely without killing the target. Observe through the second acknowledgement’s complete pre-quit/grace/safety-net window. Also explicitly inject later callbacks rather than assuming observation catches every stale event. Measure grace timing monotonically and schedule boundaries using recorded wall time. Use real OS-supported device durations, including the iOS five-minute pause.

Qualification requires three consecutive fresh runs per declared core platform row, with zero behavioural or cleanup failures. Preserve every attempt and report the total failure rate; a sequence of successes does not erase an earlier failure. Polling/read retries within one fixed deadline are allowed. Retry of an action is allowed only when it is proven idempotent and recorded; the iOS driver's existing bounded attempts need classification by this rule. A failed scenario remains failed until diagnosed; do not rerun the whole scenario until green.

## Delivery sequence

### PR 1a — Safety contracts, safe runners and complete trigger coverage

Ownership: workflow files, `scripts/system-test-common.mjs`, desktop runners, fixture launchers, `scripts/ios-test/`, testing documentation, and narrowly feature-gated `src-tauri` code if a test lease is needed.

- Run Tier 2 on every PR and `main` push initially; its current duration makes this simpler to audit than overlapping path filters. Keep existing unit, build and lint gates.
- Commit the supported OS/browser/method/package/device matrix, the failure-policy register above and a per-row owner. Undeclared support and missing prerequisites must be visible.
- Define a shared report schema: source SHA/dirty hash, built artifact identity, OS/device, browser/enforcement method, initial policy, expected/observed times, scenario verdict, logs/captures, cleanup verdict and skipped prerequisites.
- Default to fresh GitHub-hosted Windows and macOS VMs for desktop destructive, allow-mode and fault cases. They provide an isolated environment without buying or maintaining separate computers. Use an isolated self-hosted/cloud machine only for a demonstrated hosted-runner limitation; physical iOS cases still need a real device and suitable host. On a personal device allow only finite run-owned fixtures after a compatibility preflight; never Stop all, uninstall, revoke permissions or alter the clock.
- Validate ownership before deleting data, stopping processes or removing browser registrations. Keep canaries outside owned paths. Use unique run IDs, per-run profiles/data and a per-device/per-account lock to prevent concurrent runs.
- Add an external supervisor, per-run locks/directories and an iOS-style cleanup journal with explicit recovery. A desktop debug test build may also have a run-owned lease: its expiry must occur strictly after the assertion/observation deadline, must mark the run ABORTED/FAIL, and must be compiled out of release. It cannot make a release assertion pass. Lease recovery must clear only run-owned durable policy as well as native state, or the 2 s disk loop can reapply it. A killed test app needs external cleanup; an iOS callback cannot be assumed to provide independent cleanup if that callback is the subject of the test. Dedicated devices/VMs must have a validated out-of-band recovery/reset procedure. Never use cleanup as evidence of user-facing recovery.
- Keep automation/fault-injection interfaces debug/test-only and preserve release hard stops. Do not add a production remote-control endpoint.
- Require finite run-owned restrictions where the case allows it, and prove their product-enforced expiry. Indefinite Manual, allow-mode and interrupted-clear cases run only in dedicated environments with external recovery. A finite timestamp alone is not a guarantee against the broken expiry implementation being tested.

Exit: runner self-tests cover cancellation, crashes, wrong ownership, missing permissions and cleanup failure; an unblocked fixture/control baseline passes on each available platform. An unavailable platform is BLOCKED, never green.

### PR 1b — Feasible release drivers and early model tests

Ownership: desktop runner adapters/fixtures, iOS driver/provisioning, pure JS/Rust/Swift derivations and tests. Complete the writer model and differential tests described above before relying on lifecycle passes.

- First run a small feasibility workflow on GitHub-hosted macOS and Windows, using pinned OS labels and recording the actual image version. Native Tier 2 already runs on both. Extend that evidence with one owned target: launch and interact, activate a real block, complete the UI challenge, release/relaunch and sustain usability. Test external Accessibility/UIA control and the specific Automation/TCC permissions separately. Hosted-runner capability for these added cases is a feasibility result, not an assumption. GitHub supports importing signing certificates/profiles into hosted macOS runners; signing alone is not a reason to require a self-hosted Mac. Separate credentials and environments into two explicit lanes:
  - **PR lane:** maintainer approval of the exact SHA; reviewed but still untrusted code executes only on a disposable/reset login or VM with a test-only signing identity. No Developer ID, distribution or notarisation credentials are present. Approval does not make build scripts or test code inherently trusted. Fork signing lanes stay unavailable until this exact-SHA approval.
  - **Release lane:** protected builds from approved main/tag revisions with release credentials, preferably on fresh hosted runners; verify grants against the actual candidate signature, not a prior Apple Development system-test signature. This lane supplies the candidate rows in PR 6.
- Escalate to a self-hosted/cloud desktop only for a named row the hosted spike cannot support, such as unattended permission grants, reboot/sleep persistence or a missing supported OS/package environment. Keep that row BLOCKED until its alternative is proven; do not move the whole programme off Actions. Record that current standard Windows x64 images use Windows Server: those results do not automatically cover consumer Windows installation and session behaviour. Assess available Windows desktop/ARM runner rows separately.
- Physical iOS enforcement remains outside standard hosted VM coverage. Reuse the existing Mac plus connected iPad for protected local or self-hosted jobs, with exclusive device access; a simulator cannot substitute for shields and native callback evidence. No additional Mac purchase is a prerequisite for that existing setup.
- Build owned Windows and iOS target apps with an interactive heartbeat and test-owned data marker; only the macOS target currently exists. Prove the iOS target can be selected and shielded. Provision its identity separately from the driver and blocker.
- Choose and demonstrate external release-build drivers: macOS Accessibility through XCTest or an AX adapter, Windows UI Automation against the native/WebView2 surface, and the existing external iOS XCTest. Select any additional Windows library only after the spike. If a control cannot be driven or observed, define its assisted procedure and evidence before marking the row supported.
- Commit a build-differences table: the desktop debug system-test build changes bundle identity and disables production integrations including native-host registration/autostart. No release build may contain the WebDriver server or a test lease. Add a negative build check that release plus test features is rejected, an artefact/configuration check for feature absence, and a packaged smoke that no test endpoint/lease override activates. An external-driver smoke must prove one real target release before the platform lifecycle gate is implemented.
- Native-messaging tests must use a release build and real browser-launched host on a disposable account/VM. Current fixed host names/registry keys and environment-only test paths are not isolated by the system-test identifier. Verify the browser-launched host's actual data source; do not assume it inherits runner environment variables. Keep product-native identifiers in this dedicated lane rather than adding another host protocol merely for tests.

Exit: owned fixtures, clocks, provisioning and external drivers work on declared initial rows; parity checks and core actor interleavings pass. Signing/TCC/session/driver gaps are BLOCKED with an owner. Deterministic tests may proceed while hardware provisioning is blocked.

### PR 2 — macOS UI-to-app recovery first

Ownership: `e2e/system/app-watcher-system.mjs`, fixture harness and target, `e2e/system/{safari,brave}-system.js`, and runner/report integration. Consolidate duplicate `.e2e.js`/`.mjs` scenario definitions so only one source defines each safety assertion.

- Create and activate a space through UI interactions. Do not write policies or call `setBlockedApps` to stand in for the action being tested.
- Exercise warning acknowledgement with lower and upper timing bounds, pause via the real word challenge, Resume now, permanent stop and natural expiry. Trigger release while awaiting acknowledgement, during the 30 s pre-quit phase and during the 10 s post-quit/force-kill phase. For phases after acknowledgement, first prove the target is genuinely enrolled and at risk of termination.
- After each release, launch/relaunch the target and verify continued interaction. Check the control process stayed alive; release must work with Blocker backgrounded.
- Cover two overlapping rules, two processes with similar names, and a protected target. Add app allow-mode only inside the isolated test VM/account, including a fresh hosted VM once the spike passes.
- After the app lane is sound, extend Safari/Brave lifecycle assertions to loaded content and a continuously allowed control. Keep browser/method coverage explicit; Safari/Brave Automation does not imply Firefox/extension coverage.

Exit: the qualification rule above passes from fresh and existing test data. Prove sensitivity with bounded test mutations: disable watcher cancellation after policy removal, ignore a pause in disk derivation, and drop the policy-change wake-up. Each corresponding test must fail before supervisor/lease cleanup. These mutations never ship. Record uncovered browser/method combinations.

### PR 3 — Windows parity and installed-package checks

Ownership: new Windows fixture/runner adapters, shared scenario definitions, Windows workflow and packaging test integration.

- Implement the same target/control fixture protocol on Windows: normal and stubborn processes, interactive heartbeat, saved-state marker and unique process identity.
- Run the same UI lifecycle cases as macOS against the real Rust watcher. Add checks for executable names versus window labels and protection of the blocker/system essentials.
- Start with x64 app recovery and foreground UI Automation; then add the separate release-build native-messaging lane from PR 1b. Include an organisation-policy denial case and observe target/control pages.
- Add installed NSIS/MSI and MSIX smoke lanes where those formats are shipped, after the initial x64 lane: registration, app start, policy application and release after stop/expiry. Keep ARM64 as a distinct coverage row rather than inferring it from x64.
- Never run the Windows test package beside production in the same account: the existing packaging documentation explicitly warns that its identity does not isolate state.

Exit: the core app lifecycle is green on Windows x64; shipping browser/method/package combinations have explicit PASS, FAIL or BLOCKED evidence. No claimed parity based solely on Tier 2 or a successful installer build.

### PR 4 — Physical iOS app recovery and editor safeguards

Ownership: `scripts/ios-test/driver/Driver.swift`, protocol/report code and physical checklist.

- Run existing `website` and `pause` profiles against a verified signed build using its exact build report. Record upgrade baseline and continuity when installing over an existing app; an unknown installed revision cannot validate the candidate.
- Add an owned harmless target app and an unrelated control, using native picker tokens. Validate the target is eligible for shielding and not Always Allowed before testing.
- Observe app shielding and real app interaction after a timed Manual pause, scheduled pause, Resume now, Never, schedule expiry and relaunch. Include expiry/reblock while Blocker stays backgrounded.
- Exercise picker edits while a rule starts/resumes, undo, save and the persisted selection floor. Include two overlapping sources and removal of the final source on dedicated devices.
- Missed-callback injection uses a separately identified non-candidate fault build with test-only seams. Its verdict never substitutes for the signed-candidate lifecycle; record the source/configuration difference.
- Test missed schedule-end delivery separately from the normal callback path: reopen after expiry and verify the explicit reconciliation bound. Test missed resume delivery as failure to re-enforce, never confuse it with a successful pause.
- Keep authorisation, app-versus-website shields, Manual-versus-scheduled and iPhone-versus-iPad coverage distinct. If external XCTest cannot reliably observe a native case, keep it an explicit assisted release gate with evidence; do not pass it based on the frontend display.

Exit: website, scheduled pause, app shielding and timed Manual recovery have recorded physical-device verdicts for the candidate. iPhone evidence is separate from iPad evidence. Runner recovery restores only run-owned changes and any recorded temporary preference.

### PR 5 — Failure injection and minimal recovery fixes

Ownership: targeted persistence/command/monitor tests and narrowly scoped production fixes only where evidence demands them.

- Extend the actor model and differential tests established in PR 1b to native fault injection. Assert no broader or longer restriction than agreed intent permits, and no unintended release of another active rule. Store failing seeds and minimise reproductions.
- Inject errors through non-candidate fault builds or pure adapters; keep fault controls absent from signed candidates and label these results separately. Inject before/after durable writes and before/after native apply/clear: failed persistence, failed or partial registration, failed clearing, delayed/out-of-order callbacks, duplicate delivery and crash at each boundary.
- Test recovery from last-known-good data, malformed/truncated data and failed migration without deleting the only recoverable copy. Test upgrade with active, paused and expired rules. Add sleep/wake, reboot, timezone/DST and wall-clock jumps on disposable environments; do not change a personal device's clock.
- First specify the expected behaviour using the reviewed failure-policy register. A visible pending/failed operation is not an adequate terminal recovery state. Inject the failure, complete the configured challenge, and prove an explicitly chosen alternative release works within its agreed bound. Verify the route remains accessible after restart; do not automatically bypass a challenge or silently switch a timed pause to Never.
- Consider generation-tagged callbacks, durable intent, reconciliation and independently scheduled expiry only when a failing case shows a need. Do not assume the OS guarantees callback delivery or that an independent release mechanism already exists. Do not introduce automatic release for indefinite rules without an explicit product decision.

- On dedicated devices only, verify existing permitted last-resort exits leave no orphan restrictions: macOS in-app uninstall when its conditions are satisfied, Windows OS uninstall, and iOS app deletion/Screen Time authorisation revocation. Include extension/native-host remnants and record the external extension version. These are test cases for existing routes, not new in-app escape hatches, and cannot replace a normal stop/pause gate.

Exit: every injected failure has a documented outcome and bounded recovery check, or remains a tracked release-blocking gap. Each production fix has a regression that fails on its predecessor and passes with the fix. Review failure-policy changes independently before implementation/merge.

### PR 6 — Enforce the release contract

Ownership: CI/release workflows, evidence aggregation and documentation.

- Fast gate on every PR: unit/property checks and native command integration. Add hosted Windows and macOS real-app smoke as each interactive-session/permission spike passes; use exact-SHA approval and a test-only identity for signing-dependent PR jobs. The separate protected release lane proves candidate-signature behaviour. Record unavailable fork lanes explicitly. Broader browser, package and native fault cases run nightly and before release.
- Every failure-policy register entry is a required row: PASS with an exercised release route, or FAIL/BLOCKED/NOT_RUN as a release-blocking gap.
- Candidate gate: the committed target/control recovery matrix on supported macOS, Windows and physical iOS rows; upgrade continuity; real background expiry. Declare supported OS/browser/device representatives and uncovered variants in the report.
- Test the same source revision as the candidate, and record artifact hashes, signing/configuration differences and test-only capabilities. A debug system-test app alone does not prove release behaviour. Required signed-candidate rows use the external drivers/assisted procedures demonstrated in PR 1b: app pause and natural expiry in each watcher phase, restart/autostart continuity, and native-messaging apply/release. Include actual iOS app shielding, not only Safari. No test endpoint or lease is included.
- Block release on any required FAIL, BLOCKED, NOT_RUN, unexpected alert or cleanup failure. Quarantine requires an explicit, owned coverage replacement; no retry-until-pass or silent skip. Preserve first-failure evidence and recheck after a relevant fix.
- Measure sustained usability, deadline breaches and unintended control-target restrictions, not just test counts. Keep source-level, native integration and physical-system verdicts separate.

Exit: a release cannot be marked safety-verified without an attributable report for every required row. If a runner is unavailable, hold the release or make an explicit product decision about support; do not silently lower the gate. An approved OS-bound exception keeps the original deadline miss in the evidence, is labelled EXCEPTION rather than PASS, and changes the committed support matrix and user-visible guarantee explicitly. Its replacement backstop row is required and must pass. Do not apply an exception retrospectively to erase an unexplained regression or a missing recovery route.

## Order and immediate application

PR 1a precedes destructive expansion; PR 1b establishes fixtures, release drivers and deterministic actor/parity tests. PR 2 and PR 3 can then proceed independently in separate worktrees. Existing iOS website/pause checks can run once the relevant safeguards and a verified candidate are available; new app/picker cases are PR 4. Start actor/failure-policy work before platform lifecycle expansion, then add physical failure cases in PR 5. Adopt each proven gate as it becomes available rather than waiting for PR 6.

For the current cleanup PR: record existing green CI and independent static review, update to current main, run the existing macOS system suite, run iPad website/pause profiles on a verified PR build, and record assisted picker/timed-Manual cases. These are immediate confidence checks, not proof that the proposed expanded programme is complete. Do not claim new Windows real-enforcement coverage before its runner exists.

Implementation starts with PR 1a/1b and the macOS UI-to-app release case. Runtime rearchitecture, release-policy exceptions, device upgrades and destructive tests are separate concrete actions, not implied completion of this planning document.

## Decisions still required

Before implementation changes an enforcement policy, the product owner must choose the fallback for failed iOS restart registration, the recovery policy for app/website allowlist overflow, the profile identity that establishes browser compliance, the minimum recovery controls that remain reachable, and any narrowed OS-dependent deadline guarantee. PR 1a must also name the initial supported matrix and owners. Establish editing eligibility during a pause from the actual UI, and retain the current unreadable-data failure direction unless a separately reviewed change is agreed. None of these choices is resolved merely by adding tests.

## Independent review and disposition

Claude Code, using Claude Opus 5.5, performed two read-only reviews. The first required substantial changes; its findings led to the failure-policy register, explicit writer/transition map, early cross-language/interleaving tests, release-driver feasibility, phase-specific app release tests and runner-safety controls. The second supported bounded PR 1a and deterministic PR 1b work after corrections. The final revision adds its warning/global-acknowledgement oracle, separate signing lanes, durable lease cleanup, release-artifact checks, explicit OS-exception accounting and register-to-gate mapping. These final textual corrections were incorporated by the parent after the second review; no third review or runtime validation is claimed.

## Hosting amendment

Prefer GitHub-hosted runners; the earlier assumption that macOS signing implied a dedicated self-hosted machine was too strong. GitHub documents [fresh hosted macOS and Windows VMs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) and [certificate/profile installation on hosted Macs](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications). The [Windows x64 image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) is currently Windows Server. These facts support the hosting strategy, not a claim that our added native recovery tests already work there. The hosted GUI/TCC/fixture spike remains the first feasibility task. This amendment follows the two Claude reviews; it has not itself had another Claude review or a live Actions trial.
