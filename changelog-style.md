# Changelog style guide

How to write entries in `changelog.md` for **Digital Habits: Blocker**.

The changelog is the source for GitHub release notes, app-store “What’s New”
text, and the public open-source history. Write for **everyday people using the
app** — not developers, and not “tech people”. Automation should format and
filter these entries, not rewrite them into polished prose.

Empty sections are omitted from each release.

---

## Approved headings

Use only these `###` headings, in this order. Prefer the most specific product
heading that fits.

| Heading | What belongs here |
| --- | --- |
| **Branding** | App name, icons, organisation identity, installer/store branding, companion-extension naming when it is a rename or identity change. |
| **Focus Spaces & Blocking** | Focus Spaces, schedules, Quick Start, Block/Allow mode, override/stop/pause challenges, Strictness, app and website blocking, and changes to how blocking behaves (including the “Let’s go!” screen and browser setup that makes blocking work). |
| **Performance** | Speed, responsiveness, CPU, memory, battery, or similar resource use. |
| **Privacy** | What the app sends off your device, what it keeps about you, and the settings that control it (for example the anonymous usage count). |
| **Fixes & Polish** | Screen layout, wording, translations, Settings, onboarding, and other user-visible polish that does not change how Focus Spaces or blocking work. |
| **Internal** | Refactors, dependencies, tests, build/CI, signing, release publishing, docs-only edits, and other changes with no meaningful effect for people using the app. Same bullet format as other sections; keep wording clear. These stay in the GitHub changelog and are excluded from store “What’s New”. |

Do **not** add headings per screen or feature (no separate Quick Start, Settings,
Onboarding, or Localization sections). Fold those into the table above.

Do **not** use a nested `### BY PLATFORM` tree. Group by product area; mark
platform limits on the bullet.

---

## Platform tags

Supported platforms: **macOS**, **Windows**, **iOS**, and **Android**.
Desktop means macOS + Windows.

Optional tags go at the start of the bullet:

| Tag | Meaning |
| --- | --- |
| `[desktop]` | All desktop platforms; not mobile |
| `[macos]` | macOS only |
| `[windows]` | Windows only |
| `[ios]` | iOS only |
| `[android]` | Android only |

Rules:

- Before tagging, **read the app architecture** (README platform matrix,
  browser/setup docs, and how the feature actually ships). Tag from where the
  change reaches users — not from the PR machine, a single test platform, or
  where the code file lives. Example: a Firefox install-link fix is
  `[desktop]` because Firefox setup exists on both Windows and macOS, not
  Windows-only.
- Tags describe **where users experience the change**, not where the code lives.
- Omit the tag when the change applies on every supported platform.
- Prefer the narrowest accurate tag (`[windows]` over `[desktop]` when only Windows is affected).
- Do not duplicate the same change under multiple sections or with multiple tags.

```markdown
- [desktop] App updates will no longer be hidden behind the full-screen
  "Let's go!" warning.
- [macos] After a restart, the app stays running and blocking resumes
  automatically.
- [windows] Upgrading from an older ReDD Blocker installation now removes the
  old app, shortcuts and related files more cleanly.
```

Untagged bullets apply everywhere.

---

## Writing style

Write **plain sentences** for every section — including Branding, Focus Spaces &
Blocking, Performance, Fixes & Polish, and Internal. Do **not** use a bold
lead-in (`**Short title.** …`). Bold is only for product names or UI labels
inside the sentence when needed.

One or two short sentences per bullet. State the change actively and clearly.
Keep it specific enough that people recognise the change, but not so detailed
that store notes become repetitive or run over character limits.

```markdown
- When creating a Focus Space, you can now choose Block or Allow first, with
  clearer descriptions of what each option does.
- [desktop] Fixed an issue where the "Let's go!" screen could appear without
  its warning details after launch.
- The design of the Settings screen has been improved.
```

For UI/layout polish on a screen, prefer **one short screen-level bullet** over
listing each control move or label tweak:

```markdown
- The design of the Settings screen has been improved.
- The design of the create / edit Focus Space screen has been improved.
- Danish translations have been improved.
- [desktop] Onboarding text now fits properly on narrower windows.
```

Only spell out a specific Settings/onboarding detail when it is a real bug fix
people need to recognise (e.g. “Exporting focus spaces on iOS saves real
content again”), not when several small layout or copy tweaks landed together.

### Voice

- Write for everyday people. If a friend who is not technical would not
  understand a word, rewrite it.
- Prefer words they already see in the app: Focus Space, Quick Start,
  Settings, “Let’s go!”, Digital Habits: Focus.
- Say what changed in plain language. Add why it matters only when that helps.
- Sentence case. British spelling where the product UI does (e.g. Colour,
  minimise).
- One meaningful change per bullet. Keep most entries to one or two short
  sentences.

### What to keep specific vs what to fold together

- Keep **behaviour** specific under product headings: difficulty limits, drafts
  preserved, blocking fixes, typing-time estimates.
- Under **Fixes & Polish**, fold related UI/copy tweaks on the **same screen**
  into one bullet that names the screen
  (“The design of the Settings screen has been improved.”).
- Do the same for create/edit, onboarding, and similar surfaces — do not list
  every moved link, restacked button, or clearer label separately.
- Translations can be one bullet (“Danish translations have been improved.”)
  unless a new language ships (then say which language was added).
- Never flatten a real behaviour change into vague “improvements”.

### Product terms

Use consistently: **Digital Habits: Blocker**, **Digital Habits: Focus**,
**Centre for Digital Habits**, **Focus Space(s)**, **Quick Start**,
**Block** / **Allow**, **Strictness** (Committed / Flexible), **Enforcement**,
**“Let’s go!”** screen, **Screen Time** (iOS), **Automation** (macOS).

### Avoid

- Bold lead-ins (`**Short title.** Body…`) — they waste store character budget
  and read as repetitive once markdown is stripped.
- Developer or systems jargon: shell, listeners, cold-start race, re-render,
  native messaging, polling, IPC, “under the hood”.
- Hype or filler: “goes harder”, “stays solid”, “enhancements”, “various
  improvements”, “polish throughout” with no screen or topic named.
- GitHub references: pull request or issue numbers, repository or branch
  names, commit hashes, tags, or the GitHub address.
- Technical paths or slug names unless users need them (prefer “fixed the
  Firefox install link for Digital Habits: Focus” over addon IDs).
- Putting Settings wording or layout under **Focus Spaces & Blocking** just
  because a row mentions Enforcement or browsers.

Optional release summary: a leading `> …` blockquote under `## vX.Y.Z` is
allowed. Store automation may replace it with the standard intro.

---

## Classification rules

1. Classify by **what the user notices**, not by the code area touched.
2. Use a specific product heading before **Fixes & Polish**.
3. Use **Performance** only for speed, responsiveness, or resource use.
4. Use **Internal** only when there is no meaningful user-facing effect.
5. Settings copy and layout → **Fixes & Polish**, even if a label mentions
   Enforcement or browsers.
6. Blocking behaviour (including the “Let’s go!” screen) → **Focus Spaces &
   Blocking**. Broken help/install links and similar chrome → **Fixes & Polish**.
7. Add a platform tag only when the change is not universal — after checking
   architecture (which platforms that feature actually ships on).
8. Never list the same change in more than one section.

### Good vs avoid

| Change | Put it under | Notes |
| --- | --- | --- |
| Apps on schedule-only lists now close as expected | **Focus Spaces & Blocking** | Behaviour people feel; keep the wording simple. |
| Blocking uses less battery when idle | **Performance** | Resource use is the story. |
| Feedback link moved; Enforcement section clearer; Export/Import tidier | **Fixes & Polish** | One bullet: “The design of the Settings screen has been improved.” |
| Renamed “Difficulty to override” on create/edit | **Fixes & Polish** | Fold into “The design of the create / edit Focus Space screen has been improved.” |
| Listing each Settings control tweak as its own bullet | Avoid | Too granular for Fixes & Polish. |
| “Let’s go!” appears empty or can be dismissed too early | **Focus Spaces & Blocking** + `[desktop]` | Say “screen” and “warnings”, not “shell” or “listeners”. |
| Fixed Firefox install link for Digital Habits: Focus | **Fixes & Polish** + `[desktop]` | Link chrome, not blocking behaviour; Firefox setup ships on Windows and macOS. |
| Meet Digital Habits: Blocker / new icons | **Branding** | Identity. |
| CI / Partner Center submit plumbing | **Internal** | No user-facing effect. |
| ~~Missed warnings replay once listeners attach…~~ | Avoid | Too technical. |
| ~~Quick Start goes harder~~ | Avoid | Hype; say the character limit plainly. |
| ~~Various improvements~~ | Avoid | Name the screen or the behaviour. |

---

## Filtering for releases and stores

| Destination | Include |
| --- | --- |
| **GitHub Release** | Exact `## vX.Y.Z` section as markdown: update intro line, all non-empty headings, platform tags, and **Internal** |
| **Any app-store “What’s New”** | Update intro line + non-empty user-facing sections with headings; **exclude Internal** |
| **Platform store (Windows / macOS / iOS / Android)** | Untagged bullets + bullets tagged for that platform + parent tags (e.g. macOS store: untagged + `[macos]` + `[desktop]`) |
| **Platform-specific store text** | Platform tags removed; plain sentences (no `*` / other markdown) |

### Update intro line (required in `changelog.md`)

Directly under `## vX.Y.Z`, before any `###` heading, write one sentence and
**delete the parts that do not apply**:

```markdown
This update comes with some useful new features, design improvements, and under-the-hood improvements.
```

How to choose the parts:

| Phrase | Use when | Do **not** use when |
| --- | --- | --- |
| **useful new features** | Something genuinely new ships — a new capability or mode people did not have before (e.g. Allow mode, Quick Start as a new entry point, a new platform). | Improving, renaming, clarifying, or fixing something that already exists. Higher difficulty caps, clearer Block/Allow UI, better drafts, renames, and bug fixes are **not** new features. |
| **design improvements** | UI, layout, copy, translations, or screen polish. | — |
| **under-the-hood improvements** | Reliability, performance, install/upgrade cleanup, or other changes people feel indirectly. | — |

Only keep **useful new features** when there is at least one real new capability in the release. If the release only improves or fixes what is already there, omit that phrase — even if bullets sit under Focus Spaces & Blocking or Branding.

Examples:

- Allow mode ships for the first time → include **useful new features**
- Clearer create flow, Quick Start draft fix, “Let’s go!” reliability → **design** and/or **under-the-hood** only (as in v3.8.9)
- App rename / icon refresh alone → usually **design** (or skip the intro parts that do not fit); not a new feature

Store and GitHub automation copy this line as written (after stripping
markdown). They do not invent it from section headings.

### Store body shape

```text
Hi folks,

This update comes with some design improvements and under-the-hood improvements.

Focus Spaces & Blocking
- When creating a Focus Space, you can now choose Block or Allow first…
- Override typing times now use more realistic typing speeds.

Fixes & Polish
- The design of the create / edit Focus Space screen has been improved.
- The design of the Settings screen has been improved.

Remember that the app is open source — keep your feedback and suggestions coming at https://github.com/digitalhabits/dh-blocker

Cheers,
Ulrik & all of us at Centre for Digital Habits
```

Rules for that body:

- Blank line between sections (after the last bullet, before the next heading)
- No blank line between a heading and its first bullet
- No blank line between `Cheers,` and the signature
- Empty sections omitted; **Internal** omitted
- Bullets are plain sentences (no bold lead-ins in the source changelog)

Skip empty sections.

When several versions are combined into one submission:

1. Gather unpublished entries.
2. Merge bullets under the same approved headings.
3. Keep the approved heading order.
4. Keep platform tags when the destination covers more than one platform (GitHub).
5. Remove duplicates.
6. Exclude **Internal** from store text.
7. Use one update-intro line and the standard store greeting/footer only once.

---

## Example release

```markdown
## v3.9.0

This update comes with some useful new features, design improvements, and under-the-hood improvements.

### Branding

- Browser setup now uses the Digital Habits: Focus name consistently.

### Focus Spaces & Blocking

- Override typing times now use more realistic typing speeds.
- [desktop] App updates will no longer be hidden behind the full-screen
  "Let's go!" warning.
- [macos] After a restart, the app stays running and blocking resumes
  automatically.
- [windows] Upgrading from an older ReDD Blocker installation now removes the
  old app, shortcuts and related files more cleanly.

### Performance

- [desktop] Blocking uses less power when no blocked apps are running.

### Fixes & Polish

- The design of the Settings screen has been improved.
- [ios] Closing a panel or dismissing the keyboard no longer leaves the screen
  scrolled or zoomed oddly.

### Internal

- CSS minification now works on fresh installs.
- Publish now also uploads installers under the older ReDD Blocker filenames
  so existing download links keep working.
```

---

## Checklist

- [ ] Update intro line under `## vX.Y.Z` — only the parts that apply; **new features** only for genuinely new capabilities
- [ ] Only approved headings; empty ones omitted
- [ ] Most specific heading used; **Internal** only when truly invisible
- [ ] Platform tags only where needed; no `BY PLATFORM` nesting; tags checked against app architecture (README / platform matrix)
- [ ] Plain sentences only — no bold lead-ins; related UI tweaks on one screen are one screen-level bullet
- [ ] Settings UI / broken links under **Fixes & Polish**; blocking behaviour under **Focus Spaces & Blocking**
- [ ] Product terminology matches the app
- [ ] Entries are already fit for public release notes
