# Classroom mode: design

Status: built on branch `feat/classroom-mode` (this repository) and a branch
of the room server's own repository, not yet released and the server not yet
deployed. See [What is built](#what-is-built) for where the code is and what
has and has not been verified. Items marked **Proposed** were built as
described but never explicitly confirmed; **Open** items are unresolved.

## What it is

A teacher opens a *room* from a focus space. Students who already have Blocker
installed check in to the room with a short code, and their own copy of Blocker
applies the room's rules until the room's end time. A room carries what a
focus space carries: websites and apps, in block mode or allow mode. The teacher sees a
roster showing who is in the room and whether their blocking is on.

Classroom mode is one optional feature inside Blocker, off by default. There is
no separate teacher app.

## The privacy rule

The teacher learns **that** a student is or is not blocked, never **what** the
student is doing. This is enforced by the protocol, not by policy: no message
has a field for a web address, an app, a window title or a screenshot. A
student who kills Blocker, disables an extension or leaves the room shows up as
a change of state and nothing more.

Do not add activity fields to the check-in message. A "helpful" extra such as
"last blocked site" breaks the one promise the feature makes to students.

## Scope of the first version

| In | Out |
| --- | --- |
| macOS and Windows | iOS, Android, Chromebooks |
| Websites and apps, block mode and allow mode | |
| Join by code | Accounts, saved class lists |
| Fixed end time | Extending a running room (**Proposed**: out) |
| Teacher-set leave friction | Automatic restart after a force-quit |

Reasons for the exclusions:

- **iOS** suspends background apps, so regular check-ins are unreliable, and
  app selections there are tokens that only mean something on the device that
  picked them.
- **Chromebooks** cannot run Blocker. The route there is a standalone room mode
  in the browser extension, which is a later project. Keep the protocol simple
  enough for the extension to speak it directly.

## How it works

### Roles and transport

Both apps make ordinary outgoing HTTPS requests to our server, the same way the
usage ping does (`src/usage-ping.js`). There is no direct connection between
teacher and student devices: school networks commonly isolate devices from each
other and put staff and students on separate networks.

No WebSocket in the first version. Short repeated requests work wherever web
browsing works, and the messages are the same if a faster path is added later.

The server is a message board. It never contacts a device. Blocking is
enforced entirely on the student's computer from rules downloaded once at
check-in, so a server outage leaves blocking running and only makes the roster
go stale.

### Flow

1. **Open.** The teacher picks a focus space, an end time and a leave friction.
   The server stores the room's website and app rules and returns a room code and a
   teacher key. The teacher key stays on the teacher's computer and is what
   authorises reading the roster and ending the room.
2. **Join.** The student enters the code. The app fetches the room, shows the
   rules, end time, leave friction and what the teacher can see, and only then
   lets the student confirm.
3. **Enforce.** On confirm, the app writes the room to the local data file as a
   focus space plus an entry in `activeBlocks` with the room's start and end
   time, both tagged as coming from a room. `derive_payload`,
   `derive_blocked_apps` and `derive_allowed_apps` in `native_host.rs` pick it
   up like any other timed block, so the existing website and app enforcement
   applies.
4. **Check in.** About every 20 seconds the student's app sends room, install
   ID and state. The teacher's app asks for the roster about every 5 seconds.
5. **End.** The block expires locally at the end time with no server needed.
   The server deletes the room, names included, shortly after.

### States on the roster

| State | Meaning | Source |
| --- | --- | --- |
| Blocking on | Checked in, enforcement healthy | Student app |
| Not fully blocked | Checked in, but a running browser is known not to be covered | Student app. Only what it already knows: on macOS, an Automation permission denied for a running browser; on either OS, a problem the compliance enforcer has found, which requires the student to have opted in to it. A disabled extension on a computer without that opt-in is **not** detected: finding it means scanning browser profiles, which can raise macOS permission prompts and is the opt-in feature's job |
| Left | The student completed the leave friction | Student app |
| Lost contact | No check-in for about a minute | Server |

"Left" and "lost contact" must stay distinct. One is a student who did the
work to leave; the other is a student who went around it, or whose laptop lid
is closed. The server cannot tell those last two apart and should not pretend
to.

A room only reports problems. It must not switch on the opt-in setting that
force-quits non-compliant browsers (`settings.enforcementEnabled`); that stays
the student's own choice.

### Names

**Decided.** The join screen prefills the name from the computer: the user
account's full name, falling back to the computer name. The student sees it
before joining and can edit it. The app sends the confirmed name plus a yes/no
flag saying whether it was changed from the suggestion. The suggestion itself
is never sent.

The roster also:

- marks names that appear on more than one device in the room,
- shows the number checked in, so a teacher can compare with the class size,
- keeps a device's name fixed for the life of the room, keyed by a random
  install ID, so leaving and rejoining cannot change it.

**Open:** how reliably Windows returns a real name for local accounts. Where it
does not, most students will edit the field and the "changed" mark carries
little meaning.

### Leaving

**Proposed.** The teacher chooses the leave friction when opening the room:

- **Typing challenge**, reusing the existing override challenge and its
  word-count difficulty (`overrideDifficulty`), or
- **Teacher's code**, a short code the teacher gives a student who needs out.

The teacher can also release one student from the roster; it takes effect at
that student's next check-in.

Fixed rules, whatever the teacher picks:

- The friction is shown on the join screen, before the student commits.
- After check-in it can be made easier, never harder.
- Challenge length and room duration are capped, so one person's setting cannot
  lock another person's laptop for hours.
- The end time always releases the block.
- Pausing a room block counts as leaving and goes through the same friction.

This follows the product principle in `AGENTS.md`: friction is the feature.
The difference from the rest of the app is that the person who set the friction
is not the person facing it, which is why it must be shown before joining and
capped.

### Apps across macOS and Windows

App rules are stored as plain names and matched against running processes
without regard to case (`process_matches_app_label` in `app_watcher.rs`). On
macOS the name is the `.app` bundle name; on Windows it is the process name
with `.exe` dropped. A teacher and a student on the same OS therefore match
exactly. Across the two, it depends on the app:

| Teacher picks on a Mac | Windows process | Matches |
| --- | --- | --- |
| Spotify | `Spotify.exe` | Yes |
| Discord | `Discord.exe` | Yes |
| Google Chrome | `chrome.exe` | No |
| Microsoft Word | `WINWORD.EXE` | No |

The direction of a miss differs by mode, and allow mode is the costly one:

- **Block mode:** an unmatched app is not blocked on the other OS.
- **Allow mode:** an unmatched app is blocked on the other OS, so a student
  cannot open the app the teacher meant to allow.

**Proposed.**

- **Alias table.** A small built-in list pairing the macOS and Windows names
  of common apps (browsers, Office, Teams and similar). A room's app list is
  expanded through it when the room is written on the student's device.
- **Typed names.** The picker already accepts a typed app name, so a teacher
  can add the other OS's name for anything the table lacks.
- **Join-screen check.** In allow mode, the join screen lists any allowed app
  it cannot find installed on this computer, so the student and teacher learn
  about a mismatch before the lesson, not during it.

Joining a room with apps follows the existing app-blocking flow: an open
blocked app raises the warning overlay and the student gets time to save
before it is quit. The join screen must say that open apps will be closed.

### Rooms and the student's own focus spaces

Today concurrent allow-mode spaces union, and blocklists win on overlap. A
room in allow mode would be widened by any allow-mode space the student starts
themselves, for websites and for apps.

**Proposed.** While a room block is active, the student's other allow-mode
spaces are left out when rules are derived. The student's blocklists still
apply. For websites this is one change in `derive_payload`; the browser
extension and `block_page.rs`, which compute the final policy from the
payload, need no change. For apps it is `derive_allowed_apps`, and the
frontend merge it mirrors (`collectAllowedApps`), which must change together.

This is an enforcement change and needs regression tests that fail before it
is applied.

## Which way failures fall

| Situation | Behaviour | Why |
| --- | --- | --- |
| Server unreachable after check-in | Keep blocking until the end time | The student agreed to the end time; the roster is the only thing that needs the server |
| Server unreachable at check-in | Do not join | Rules cannot be shown, so the student cannot agree to them |
| Room data on disk is unreadable or has no end time | Do not enforce it | A room without an end time could never release |
| "End room" cannot reach a student | Block runs to the end time | Same as above |
| System clock moved forward | Block ends locally; next check-in reports "left" | Time-based blocks already behave this way |
| Check-ins stop | Roster shows "lost contact" | Silence is the only signal a killed process can give |

## Known limits

- **Force-quit on macOS removes blocking.** Nothing restarts Blocker after it
  is killed; it returns at the next login or manual launch. Safari, Chrome,
  Edge and Brave on macOS are blocked from inside the main app by default, so
  killing it frees them. The teacher sees "lost contact".
- **Force-quit removes app blocking on both OSes.** App blocking runs inside
  the main app.
- **Force-quit on Windows leaves website blocking on.** Extension-based blocking is
  served by the native host, a separate process the browser starts, which
  reads the data file itself. Websites stay blocked while the roster shows
  "lost contact". Sending check-ins from the native host as well would fix
  that false alarm; not planned for the first version.
- **Uncovered browsers.** A browser Blocker does not support is not blocked
  and not reported. **Open:** confirm current behaviour.
- **This was read from code, not tested** by killing a running app.

## Data held on the server

Per room: the website and app rules, end time, leave friction, a hash of the teacher
key. Per student in the room: install ID, confirmed name, "name changed" flag,
current state, time of last check-in.

No accounts. Everything is deleted when the room ends. Students are often
minors, so schools may ask where this is hosted and for a data processing
agreement.

Possible later step: encrypt names and rules on the devices with a key carried
in the room code, so the server holds only unreadable data plus timestamps. It
makes the code longer to type.

## What is built

| Piece | Where |
| --- | --- |
| Room rules in enforcement | `native_host.rs` (`is_room_block`, `one_off_in_force`, `allow_room_in_force`), tests in `native_host/tests.rs` |
| The same rules for what the frontend pushes and offers | `src/classroom-core.js`, used by `blocking-platform.js`, `schedule-engine.js`, `unlock-duration.js`, `settings.js` |
| Server calls and the 20-second check-in | `src-tauri/src/classroom.rs`. The check-in runs in Rust because macOS throttles webview timers while the window is hidden |
| Screens | `src/classroom.js`: the bar above the focus-space list, join, leave, open a room, roster |
| Setting | `settings.classroomEnabled`, off by default, in Settings |
| Room server | A separate repository |

Two implementations of the room rules exist on purpose, Rust and JavaScript,
like the iOS resolvers. Rust decides what is enforced; the JavaScript decides
what is pushed to the app watcher and shown. Change them together.

Choices made while building, beyond the sections above:

- **The pause flag is ignored for room blocks in the derivation itself**, not
  only hidden in the UI, so nothing that writes `isPaused` can suspend a room.
- **Stop all leaves room blocks in place.**
- **A room's focus space is hidden** from the student's own list, the
  selector and exports. The classroom bar and the calendar show it.
- **The student's app re-checks the room it is given**: an end time is
  required and capped at 4 hours on the device, whatever the server says.
- **Only an explicit server answer releases a student early.** An unreachable
  server, an unknown room or a refused token all mean "keep blocking to the
  end time".
- **The teacher's leave code never reaches the server.** A salted hash does,
  and students' apps check a typed code against it, so it works offline.
- **The server saves open rooms to a volume**, so a deploy does not blank
  rosters. A room is deleted about 10 minutes after it ends.
- **Release builds cannot be pointed at another server.** `DH_CLASSROOM_URL`
  is read in debug builds only.

Verified:

- Rust unit tests, including five room cases, two of which failed before the
  change; frontend unit tests, four of which failed before the change; the
  in-app logic suite; 20 server tests.
- Two real frontends, teacher and student, driven against the real server in
  a browser with Tauri stubbed: open, join, roster, leave by typing, leave by
  code, let out, end. Screenshots were inspected in light and dark.
- The Rust request code against the real server
  (`classroom::tests::live_server_round_trip`, ignored by default).

Not verified:

- **The real app end to end.** The room server has not been deployed and the
  built app has not been run against it, so a room has not yet blocked a real
  browser or closed a real app. Use `scripts/manual-test-checklist.md`
  alongside a dev build started with `DH_CLASSROOM_URL` set.
- **Windows.** Nothing here was compiled or run on Windows. The one
  Windows-only call (`GetUserNameExW`, for the suggested name) was checked
  against the `windows` crate source by reading.
- **iOS.** Classroom mode is hidden and its data stripped on load; covered by
  unit tests only.
- **The check-in while the window is hidden** on a real machine.

## Open decisions

- **Hosting.** **Decided:** a small service of its own, separate from the
  app. Rooms are short-lived, so the service needs little or no database. Keep
  the messages independent of the host so it can move later. Distance to the
  server is not a concern at one request every 20 seconds; where the data is
  stored is, for schools.
- **Extend.** **Proposed:** not in the first version.
- **Leave friction options.** **Proposed:** as described above.
- **Room override of allow-mode spaces.** **Proposed:** as described above.
- **Apps across OSes.** **Proposed:** alias table, typed names and the
  join-screen check, as described above.

## Build order

Each step is its own pull request.

All four are built; they are kept here as the suggested order for review.

1. **Room block on the device.** Data format for a room block, the allow-mode
   override for websites and apps, the app alias table,
   pause-counts-as-leaving. No network, no UI. Tier 1 and Rust unit tests.
2. **Server endpoints.** Create room, join, check in, roster, end. In the
   server's repository.
3. **Student side.** Join screen, name prefill, leave friction, check-ins.
4. **Teacher side.** "Open as room" and the roster.

## Other platforms

`src/` ships to iOS as well. Classroom mode must be hidden there, and the room
tag on focus spaces and active blocks must be ignored by the iOS resolvers
(`src/allowlist-ios.js` and `IOSPolicyResolver`), so that a data file imported
from a desktop does not change iOS behaviour. Android lives in its own
repository and is unaffected.
