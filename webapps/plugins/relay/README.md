# relay plugin

The voltage-side client for a **self-hosted relay server** (Express file server + OnlyOffice
DocumentServer; relay keeps its own desktop as the backend). Named after the service rather than
after one feature — further relay capabilities belong here, not in a second plugin.

What it does today is relay's document editing: it syncs a local Office file to the relay server and
opens it there. Double-click a `.docx`/`.xlsx`/`.pptx` in the file browser → the AppImage uploads it
to your personal folder on relay via its file API, navigates to relay's editor page, and **pulls the
edited file back over the local one when the window closes** — the local file stays the source of
truth. It carries no credential of its own: everything rides on the relay login session the app
profile already holds.

Architecturally this is the [rclone-sync](../rclone-sync/rclone-sync.js) pattern (launch-arg
takeover → loading page → upload → editor → sync-back on close, with a conflict dialog) speaking
plain REST instead of driving the rclone binary.

## Backend contract

relay's file API (see the relay README, *File API*). Everything — API **and** editor page —
authenticates with the same thing: the **relay login session** of the app's own profile.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/session` | `{ user, csrf }` — signed in? plus the CSRF proof |
| `GET` | `/api/files` | list → `{ files: [names] }` |
| `PUT` | `/api/files/<name>` | upload/overwrite (raw body, `X-CSRF-Token`) |
| `GET` | `/api/files/<name>` | download |
| `POST` | `/api/files/<name>/forcesave` | save the open editor session now (`X-CSRF-Token`) |

A session only ever sees its own user folder. Because the API hangs on a cookie, relay checks it
for CSRF like any form — hence the header on the writing calls, and hence `/api/session`, which
exists so the plugin can fetch that proof without scraping a rendered page (at launch the window
is on this plugin's own `data:` loading page).

Two consequences worth knowing:

- Every request goes through **`ses.fetch`** — the Electron `Session` of the app's WebContents,
  i.e. Chromium's network stack. Node's global `fetch` has its own stack and would send no cookie
  at all. That one detail is what makes token-free operation possible.
- A **401 means "not signed in"**, not "misconfigured". The plugin then loads relay's login page,
  waits for the sign-in to go through, and continues the upload — the password is typed into
  relay's own form, voltage only ends up holding the cookie.

> **There is no API token any more.** There used to be one, baked into the AppImage's
> `pluginConfig` at build time. It was an unlimited full-account credential (relay would even turn
> it into a session), it sat in plaintext in the build, and revoking it meant re-issuing one for
> every client at once. The session expires, is stored per device and can be ended individually.
> A built AppImage is therefore no longer personal.

## Setup

1. Add the plugin. **There is nothing to configure** — the build config needs no `pluginConfig`
   entry for it.
2. Build & install the app (the build config ships `acceptsFileArg` + the docx/xlsx/pptx MIME
   registrations, so the system offers the app for those files).
3. Launch it once and log in. The session lives in the app's own profile and — since relay uses
   rolling 90-day sessions — holds until the profile is discarded. If it ever lapses, the next
   document opening just shows the login page first.

The plugin still ships a gear dialog, deliberately empty: further relay capabilities belong in this
plugin rather than in a second one, and they will want settings. A field added to `config.html`
binds itself through `data-config-key` with no host change.

### Where the server address comes from

The app's own **`url`** — there is no separate setting. A relay app opens the document list, and
that list *is* the instance root, the same root `/api/` and `/edit/` hang off. A second field would
only be another place for the two to drift apart, and they did exactly that once: an app pointing
at `localhost` while its home button went to a public host.

The reverse-proxy case survives because nothing reduces the URL to its origin: `http://black/relay`
stays `http://black/relay`, prefix included. The one shape this cannot express is an app that
deliberately starts *deeper* than the instance root (say `…/chat`) while still syncing files — if
that ever comes up, an optional override belongs in the dialog above, as an exception rather than a
required field.

## Runtime flow

1. Launched **without** a file → normal window on `pkg.url` (the backend's file list); plugin inert.
   A `pkg.url` that isn't usable as a backend root → also inert, with a `[relay-plugin]` log line.
2. Launched **with** a file: loading page, then `GET /api/session`. Not signed in → relay's login
   page, and the flow resumes once it is through; backend unreachable → straight to `pkg.url`.
   Then
   - not on the server yet → upload → editor.
   - on the server with **identical content** (md5) → skip the upload, open the editor directly.
   - on the server with **different content** → a **comparison dialog** (like the rclone/Google flow):
     the file's name plus a local-vs-server table of *modified time* and *size*, then **Overwrite**
     (push local up) or **Open existing** (keep the server version; the local file is then only
     overwritten after an explicit prompt on close). The server's mtime/size come from the download the
     plugin already does to compare content (`res.download` sets `Last-Modified` + `Content-Length`), so
     no extra metadata endpoint is needed.
3. On window close: the plugin first calls the backend's **`POST /api/files/<name>/forcesave`**, which
   asks the DocumentServer to save the open session *now* instead of waiting out its ~10 s
   post-disconnect grace. **The forcesave result never decides whether to download** — that is always
   the content comparison (does the server file differ from the state at open?). It only bounds how
   long the plugin waits for a still-pending write:
   - **`saved:true`** (or an older backend with no endpoint) → a write is coming → show the sync
     spinner and poll up to ~15 s until the server file differs, then overwrite the local file
     (forcesave usually lands it in ~1 s).
   - **`no-changes`** → nothing *further* is being written, but the DS **autosaves during editing**, so
     the edits are often already on the server. The plugin still probes once (immediately) and pulls
     the file if it differs; only a genuinely view-only session finds no difference and closes fast
     (~1.5 s). *This is deliberate:* an earlier version trusted `no-changes` to skip the pull and
     silently dropped every autosaved edit — the sync-back never ran.
   Silent after an upload; with a prompt after "open existing" (and there the server version is applied
   even without a new save, since it differed from local from the start). A failed download leaves the
   local file untouched and never blocks the window from closing.

   The forcesave path needs the backend to know the open session's document key, which it captures when
   `/edit` is served (an in-memory map). After a backend restart the key is gone → forcesave reports
   `no-session`; the plugin then waits the full window (the DS's own grace save may still be coming).
4. Any API failure (server down) falls back to loading `pkg.url` normally.
5. Apps that also load the **widget** plugin get a home button (this plugin's glyph) on the drag
   strip: it routes the app back to the document list (the app's own `url`, so a reverse-proxy path
   prefix like `http://black/relay` works too), which the editor page has no link back to. It shows
   only while an editor page (`<base>/edit/…`) is open and hides on the list itself.

The prompt pages answer through the generic `rclone-confirm` preload bridge
(`window.electronAPI.rcloneConfirm`) — plugin-agnostic plumbing despite the historical name, so no
core/preload change was needed.

## Limits

- One file per window: a second file opened while a window is up starts a second window (the app is
  deliberately **not** `singleInstance`); the plugin implements no `onLaunch` re-dispatch.
- Conflict comparison downloads the server file to hash it (the list endpoint returns names only) —
  fine for Office-sized documents.
- With forcesave (current backend) close is fast in both cases (instant when unchanged, ~1 s when
  saved). The `SAVE_WAIT_MS` (15 s) ceiling only applies to the fallback path against an older backend
  without the forcesave endpoint.
