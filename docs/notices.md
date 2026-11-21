# Remote notices

A way to tell users about a problem with the app without shipping a release:
for example, that the in-app updater fails until they restart their Mac, and
what to do instead.

The app reads [`notices.json`](notices.json) from
`https://digitalhabits.github.io/dh-blocker/notices.json`. GitHub Pages serves
it straight from `main`, so **merging a change to `docs/notices.json` publishes
it**. No release, no build. Allow up to about ten minutes for the Pages cache,
and up to an hour for a running app to pick it up (it checks at launch, hourly,
and when its window is shown after at least 15 minutes away).

Only builds that include `src/notices.js` (the release after 3.13.0 onwards)
read this file. To reach older installs, the update banner's “What's new?”
panel is the only other channel: it renders the remote `changelog.md`.

## Publishing a notice

Add an entry to the `notices` array and open a PR. The Tier 0 test
`test/tier0/notices.test.js` validates every entry, so a typo fails CI rather
than producing a notice that silently never shows.

```json
{
    "notices": [
        {
            "id": "2026-11-macos-updater",
            "severity": "critical",
            "platforms": ["macos"],
            "minVersion": "3.12.0",
            "maxVersion": "3.13.0",
            "expiresAt": "2026-12-15T00:00:00Z",
            "title": "Updates may fail until you restart your Mac",
            "body": "If installing an update shows an error, restart your Mac and try again. Your blocks keep working in the meantime.",
            "link": { "label": "Download the installer", "url": "https://github.com/digitalhabits/dh-blocker/releases/latest" },
            "dismissible": false
        }
    ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique and stable. Dismissals are remembered by id, so to show a revised notice again to people who dismissed it, give it a new id. |
| `title` | yes | One line. |
| `expiresAt` | yes | ISO 8601 time after which the notice is hidden. Required so a forgotten notice still goes away. |
| `body` | no | Supports `**bold**`, `*italics*` and `[label](https://…)` links. Everything else is escaped. |
| `severity` | no | `info` (default, blue-grey), `warning` (amber) or `critical` (red). |
| `platforms` | no | Any of `macos`, `windows`, `ios`. Omit for all. Windows includes Microsoft Store installs. |
| `minVersion`, `maxVersion` | no | Inclusive app version bounds, e.g. `"3.13.0"` (no `v`). |
| `startsAt` | no | ISO 8601 time before which the notice is hidden. |
| `link` | no | `{ "label", "url" }`; shown as a button. `https://` only. |
| `dismissible` | no | Default `true`. `false` removes the close button, so the notice stays until it expires or is removed from the file. |

Every notice that applies to an install is shown, each as its own banner,
most severe first; notices of equal severity keep their order in the file.
They sit below the update banner and above the browser-setup banner. Nothing
caps how many show, so keep the number live at once small: if two notices
would reach the same installs, consider merging them into one.

`title`, `body` and `link.label` can also be objects keyed by language
(`{ "en": "…", "da": "…", "zh-CN": "…" }`); English is the fallback.

## Taking a notice down

Delete the entry, or let it expire. Either way it disappears within the hour
on running apps. Leave the array empty (`"notices": []`) when nothing is live.

## Guarantees and limits

- **Display only.** A notice cannot change blocking, schedules or settings.
  Whoever can merge to `main` can put text and an https link in front of
  users, and nothing more.
- **Fails towards silence.** If the fetch fails, the JSON is invalid or an
  entry does not validate, that notice is not shown. A notice already on screen
  stays until it expires, so a flaky connection does not make it flicker.
- **Separate from the updater.** The check uses the webview's `fetch`, not the
  Rust HTTP client that downloads updates, so the notice still arrives when the
  update download path is what broke.
