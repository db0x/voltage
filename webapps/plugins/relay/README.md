# relay plugin

The voltage-side client for a **self-hosted relay server** (Express file server + OnlyOffice
DocumentServer; relay keeps its own desktop as the backend). Named after the service rather than
after one feature — further relay capabilities belong here, not in a second plugin.

What it does today is relay's document editing: it syncs a local Office file to the relay server and
opens it there. Double-click a `.docx`/`.xlsx`/`.pptx` in the file browser → the AppImage uploads it
to relay, navigates to relay's editor page, and **pulls the edited file back over the local one when
the window closes** — the local file stays the source of truth. It carries no credential of its own:
everything rides on the relay login session the app profile already holds.

**Where it uploads depends on whose file it is.** A document that already lives in your relay folder
goes there, as before, and stays. A document that only exists on your local disk goes to relay's
**scratch area** instead and is **deleted again after the last sync** — it is uploaded solely because
OnlyOffice needs a URL to open, so it never appears in the file list, the search, your used space or
the backup. Without that split, editing a local file quietly turned one document into two.

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

For a document relay does **not** own, the same four steps run against the scratch area instead:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/scratch?name=<basename>` | hand a local file up (raw body, `X-CSRF-Token`) → `{ id, name, bytes, edit }` |
| `GET` | `/api/scratch/<id>` | download the current state (this is what the sync-back reads) |
| `DELETE` | `/api/scratch/<id>` | drop the copy; idempotent (`X-CSRF-Token`) |
| `POST` | `/api/scratch/<id>/forcesave` | save the open editor session now (`X-CSRF-Token`) |

The **id comes from the server and is random** — the file name lives in the query string, as a title
and a source of the extension, never as the address. Two `brief.docx` open at once from different
folders would otherwise overwrite each other. A relay that predates the scratch area answers `404`
to the `POST`; the plugin then takes the old route into the user's folder, so an outdated server
costs the tidy-up but not the ability to edit.

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

1. Add the plugin. The only thing to configure is which app opens which kind of document (see
   below); without that it behaves exactly like relay in a browser.
2. Build & install the app (the build config ships `acceptsFileArg` + the docx/xlsx/pptx MIME
   registrations, so the system offers the app for those files).
3. Launch it once and log in. The session lives in the app's own profile and — since relay uses
   rolling 90-day sessions — holds until the profile is discarded. If it ever lapses, the next
   document opening just shows the login page first.

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

1. Launched **without** a file → depends on what the app is. The desktop app opens its file list
   (`pkg.url`, already loading — nothing to do). An app that owns exactly one file type was just
   started from the menu with no document, and the only sensible reading of that is *a new one of
   these*: it goes straight to relay's create dialog, `<base>/?neu=<ext>`. A `pkg.url` that isn't
   usable as a backend root leaves the plugin inert, with a `[relay-plugin]` log line.
2. Launched **with** a file: loading page, then `GET /api/session`. Not signed in → relay's login
   page, and the flow resumes once it is through; backend unreachable → straight to `pkg.url`.
   Then
   - not on the server yet → **scratch upload** → editor. This is the purely local document: relay
     keeps the copy only for as long as the window is open.
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

   **Then, for a scratch copy only, the plugin deletes it** (`DELETE /api/scratch/<id>`) — after the
   pull, deliberately, and outside its error handling: a failed sync is exactly when the copy is still
   wanted, and a failed delete must not keep the window open. Whatever happens, relay expires scratch
   copies by itself after 12 hours, so a crash or a dead network cannot leave one behind for good. A
   file that belongs to the user in relay is **never** deleted — the two cases are decided once, at
   launch, and carried in the target's `kind`.

   The forcesave path needs the backend to know the open session's document key, which it captures when
   `/edit` is served (an in-memory map). After a backend restart the key is gone → forcesave reports
   `no-session`; the plugin then waits the full window (the DS's own grace save may still be coming).
4. Any API failure (server down) falls back to loading `pkg.url` normally.
5. Apps that also load the **widget** plugin AND own the document list (see `ownsDocumentList`) get
   a home button (this plugin's glyph) on the drag strip: it routes the app back to the document list (the app's own `url`, so a reverse-proxy path
   prefix like `http://black/relay` works too), which the editor page has no link back to. It shows
   only while an editor page (`<base>/edit/…`) is open and hides on the list itself.

The prompt pages answer through the generic `rclone-confirm` preload bridge
(`window.electronAPI.rcloneConfirm`) — plugin-agnostic plumbing despite the historical name, so no
core/preload change was needed.

## Documents in a real window

relay draws its own window manager inside the page: documents open as draggable pseudo-windows on
its desktop. In a browser tab that is the right answer — there is nothing else. Inside voltage it
simulates something the machine already has, so a document can be handed to a **real application
window** instead: a separate AppImage with its own icon, its own taskbar entry, its own zoom.

**Which app opens what is configured in the gear dialog**, one choice per document family:

| Setting | Covers |
|---|---|
| `appPdf` | `.pdf` |
| `appWord` | `.docx .doc .odt .rtf .txt` |
| `appCell` | `.xlsx .xls .ods .csv` |
| `appSlide` | `.pptx .ppt .odp` |

Four settings, not one per extension: they follow relay's own families (`DOCTYPE` in its
`backend/config.js`), and the plugin mirrors that table. The default for all four is **leave it in
relay**, so an unconfigured app behaves exactly as relay does in a browser — handing documents out
is opt-in.

The choices come from `stacks()`, which runs in the MANAGER's main process and lists the apps that
are actually **built**. What gets stored is the AppImage's **path**, because that is the only
identity the runtime can act on: a built AppImage carries neither `webapps/` nor `dist/`, so it
cannot turn a profile name back into an app. An assigned app that no longer exists resolves to
null, i.e. the document stays in relay rather than the setting silently doing nothing.

A document window opens already signed in: the second process shares the app profile and therefore
the relay session cookie. (Verified — a concurrent second instance reads the *persistent* cookie;
relay's is a 90-day one.)

### How the two sides find each other

1. This plugin exports **`preloadArgs()`** → `--voltage-runtime=relay`. That argument reaches the
   preload through `additionalArguments`, i.e. at document-start before any page script.
2. voltage's preload therefore exposes **`window.voltage`** = `{ runtime, openDocumentWindow(url) }`.
   Opt-in per app: without this plugin no page is handed a way to spawn windows. Detection is
   deliberately *not* done via the User-Agent — that string travels into logs and third-party
   analytics, and a marker there would be a statement about the user; a property on `window` is
   visible only to the page itself.
3. relay's [`core/voltage.js`](../../../../relay/backend/public/js/core/voltage.js) reads it, and its
   click handler offers EVERY document address to the runtime. Which of them actually leaves is the
   runtime's decision — relay does not know the assignment.
4. Main resolves in three steps: the **assignment** above; then voltage's **routing table**
   (`claimsUrl` / `routeUrl`), which answers the different question "who owns this URL no matter who
   links to it"; then **false**. `claimsUrl` comes first because `routeUrl` skips the current app —
   inside the viewer itself a document would otherwise be handed back to the base owner.
5. `false` makes relay fall back to its own window, so a click never lands nowhere. That also covers
   a dev run and an unconfigured app.

`mayOpenDocumentWindow` bounds the whole capability to editor pages of *this* backend — path prefix
included, so an app at `http://black/relay` cannot be steered to `http://black/other`. A bare origin
check would allow exactly that.

### Two apps on one relay instance

Both derive the same base key (`localhost:5001`), and only one app can hold it — the base claim
decides where a link from *elsewhere* goes. The manager therefore **warns instead of refusing**
(it used to refuse, which made a second app impossible to create), and `updateRoutingTable` keeps
the first and says so rather than silently dropping the other's claim. Which one is first follows
config filename order; give the second app a start URL of its own if that tie-break ever matters.

A `routingUrls` claim on the viewer (e.g. `http://localhost:5001/edit/*.pdf`) is optional on top: it
makes relay links of that kind open there from *anywhere* in voltage, not just from a click inside
relay.

### A fileless launch means "new document"

`neueDateiEndung(pkg)` reads the app's own `mimeTypes` and answers with the extension relay would
create — `docx`, `xlsx`, `pptx`. The table mirrors relay's `backend/blank/`: those three are the
only kinds relay has a template for. **PDF answers null on purpose** — a PDF is exported, not
created — so the PDF viewer keeps the plain file list, as does the desktop app.

relay's side of it: `?neu=<ext>` opens the create dialog with that type preselected and takes the
marker back out of the address (the same pattern as `?open=` and `?hl=`, so a reload does not tear
it open again). An unknown or template-less extension opens nothing at all.

Two details make it work end to end:

- The dialog carries a hidden `ganzseitig` flag when it was reached that way, and `/create` then
  redirects to the **full-page** editor instead of the file list with a drawn window inside it —
  which would put the second desktop right back into a single-document app. In a browser nothing
  changes; the toolbar button leaves the flag empty.
- `loginRequired` now hands `req.originalUrl` to `?next=` instead of the bare path. The query is
  part of the target, and it is the FIRST launch — with the login still pending — where a deep link
  would otherwise be lost. `internesZiel()` already accepted path *and* query.

### Who handles LOCAL files

A viewer needs this plugin only if it is also the desktop handler for that file type — the
`mimeTypes` / `acceptsFileArg` pair. That path is the plugin's original one: the file arrives as a
launch argument, gets uploaded, opened, and written back on close. Without the plugin an
`acceptsFileArg` app would silently ignore the file it was started with, because nothing else reads
`launchArg`.

For a viewer that is ONLY ever reached through a document URL, the plugin is dead weight — give the
binding to whichever app should own the file type and leave the rest without it.

The home button no longer follows from loading the plugin. `ownsDocumentList` decides: the button
means "back to the document list", which is an answer only for the app whose home that list is. It
asks voltage's own resolution (`claimsUrl`) who owns the backend root — the instance app answers
yes, a viewer that owns one file type answers no. So a viewer can take the local-file handling
without turning into a second desktop. A dev run owns nothing and therefore shows no home button.

## Limits

- One file per window: a second file opened while a window is up starts a second window (the app is
  deliberately **not** `singleInstance` — which is also what lets the document windows above be
  their own processes); the plugin implements no `onLaunch` re-dispatch.
- Only an explicit CLICK routes a document to its own window. A deep link (`?open=…`) opens in place
  as before — routing that too would risk a launch loop for no gain.
- The extension→family table is mirrored from relay's `DOCTYPE`. A new format added there needs the
  same line here, or it simply never leaves the relay window.
- Conflict comparison downloads the server file to hash it (the list endpoint returns names only) —
  fine for Office-sized documents.
- With forcesave (current backend) close is fast in both cases (instant when unchanged, ~1 s when
  saved). The `SAVE_WAIT_MS` (15 s) ceiling only applies to the fallback path against an older backend
  without the forcesave endpoint.
