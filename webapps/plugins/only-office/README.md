# only-office plugin

Syncs a local Office file to a **self-hosted OnlyOffice backend** (the *oold* family setup:
Express file server + OnlyOffice DocumentServer) and opens it there for editing. Double-click a
`.docx`/`.xlsx`/`.pptx` in the file browser → the AppImage uploads it to your personal server
folder via the backend's file API, navigates to the backend's editor page, and **pulls the edited
file back over the local one when the window closes** — the local file stays the source of truth.

Architecturally this is the [rclone-sync](../rclone-sync/rclone-sync.js) pattern (launch-arg
takeover → loading page → upload → editor → sync-back on close, with a conflict dialog) speaking
plain REST instead of driving the rclone binary.

## Backend contract

The backend's token-authenticated file API (see the oold README, *Datei-API*):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/files` | list → `{ files: [names] }` |
| `PUT` | `/api/files/<name>` | upload/overwrite (raw body) |
| `GET` | `/api/files/<name>` | download |

Auth: `Authorization: Bearer <apiToken>`; every token only sees its own user folder.

The **editor page** (`/edit/<name>`) is *not* token-authenticated — it uses the backend's login
session cookie. That fits voltage naturally: the app's isolated profile keeps the 90-day session,
so you log in **once** in the app window; `/login?next=` carries the editor target through that
first login.

## Setup

1. Configure the plugin (gear dialog): **Server URL** (e.g. `http://192.168.0.33:5001`) and your
   **API token** (backend start page → "API-Token", after logging in).
2. Build & install the app (`build.private.onlyoffice.json` ships `acceptsFileArg` + the
   docx/xlsx/pptx MIME registrations, so the system offers the app for those files).
3. Launch once without a file and log in — that seeds the session cookie for the editor.

> The API token is baked into the AppImage's `pluginConfig` at build time (the config file is
> gitignored) — treat built AppImages as personal, like the docker plugin's secrets.

## Runtime flow

1. Launched **without** a file → normal window on `pkg.url` (the backend's file list); plugin inert.
   Missing `baseUrl`/`apiToken` → also inert, with a `[only-office-plugin]` log line.
2. Launched **with** a file: loading page, then
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
4. Any API failure (server down, bad token) falls back to loading `pkg.url` normally.
5. Apps that also load the **widget** plugin get a home button (this plugin's glyph) on the drag
   strip: it routes the app back to the document list (the configured `baseUrl`, so a reverse-proxy
   path prefix like `http://black/relay` works too), which the editor page has no link back to. It
   shows only while an editor page (`<baseUrl>/edit/…`) is open and hides on the list itself.

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
