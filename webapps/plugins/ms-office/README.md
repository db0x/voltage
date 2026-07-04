# ms-office plugin

Routes Office **document opens to the voltage app that owns the file type**: click a `.docx` in
OneDrive and it opens in the Word app, an `.xlsx` in Excel, a `.pptx` in PowerPoint, a OneNote note
in OneNote — instead of a second OneDrive window or a browser tab. Selected per app on the Microsoft
apps (OneDrive/Word/Excel/PowerPoint/OneNote); it has no settings dialog.

Which app claims which URL comes from the shared routing table (`routing.json`, fed by each app's
`routingUrls` — see [Advanced routing patterns](../../../README.md#advanced-routing-patterns) for the
SharePoint `Doc.aspx` query-string and OneNote negation patterns). The target app must be **built**
for a route to fire; unclaimed URLs go to the system browser.

## Why a main-process plugin (and not a page script)

OneDrive opens a document by calling `window.open()` from a **cross-origin iframe**. A script
injected into the page only lives in the top frame and can never see that call — but the resulting
new-window event always surfaces in the main process, so this is the only place that can reliably
observe and steer it.

## How the routing works

`window.open()` is called with a *launcher* URL (or even a host-less `about:blank` placeholder that
OneDrive reserves synchronously against popup blockers), not the document URL — so the central
`setWindowOpenHandler` can't route it directly. The real editor URL (`…sharepoint.com/:w:/…`) only
appears a moment later, when the freshly opened child window navigates. The plugin therefore:

1. Allows launcher/placeholder popups, but **hidden** (`show: false`) — a routed document never
   flashes a stray window, and `about:blank` no longer pops an empty tab.
2. Watches the hidden child's navigation events (`will-navigate`, `will-redirect`, `did-navigate`,
   `did-navigate-in-page` — the SPA case can be observed but not prevented).
3. As soon as a URL appears that an app claims, it decides in this order (**order matters**):
   1. **Self first** — this app owns the doc (a OneNote note opened from OneNote): load in place.
      Checked before routing because a broad/stale routing key in another built app can match the
      same `*-my.sharepoint.com` host and would otherwise steal the note.
   2. **Another built app claims it** — launch that AppImage, discard the hidden child.
   3. **Nobody claims it** — system browser.
4. A child that never routes within **1.5 s** is a genuine OneDrive popup and is revealed.

Everything logs under `[ms-office-plugin]` — launch the app from a terminal to see each
`window.open`/routing decision with the exact URL that drove it.

## Pitfall for plugin authors

The handlers must bind to **`api.webContents`**, not `win.webContents`: when the app also loads the
**widget** plugin it runs in an inset `WebContentsView` (view mode), where `win.webContents` is the
transparent host window — binding there silently attaches to the wrong contents and no event ever
fires.
