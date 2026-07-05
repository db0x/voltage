# widget plugin

Renders an app as a frameless, transparent, rounded **desktop widget** — no titlebar, optional drop
shadow and background tint, hidden scrollbars, and its own affordances for the things a frameless
window loses: moving, window controls, and (with the [GNOME integration](../../../README.md#gnome-integration))
staying out of the dock.

## Rendering model (view mode)

The app does **not** run in the window itself. The window is a transparent, frameless *host* that
only draws the drop shadow; the app runs in an inset `WebContentsView` with rounded corners. This
keeps the wrapped page completely untouched — native scrolling and layout, no clip-path/transform
tricks (which broke pages' own scroll containers). The plugin only injects a tint and hides
scrollbars *inside* the view.

Consequences other code has to know about:

- The app's `webContents` is **not** `win.webContents` — plugins must use `api.webContents`
  (see the ms-office plugin's header comment for the bug this caused).
- `window.close()` is neutralised automatically for widget apps (`blockWindowClose` behaviour),
  since the page must never be able to close its frameless host.
- DevTools open **detached** (no room for a docked panel in a frameless window).

## Top drag strip

Moving a frameless window needs a drag surface. The widget renders its own **overlay strip** (a
separate `WebContentsView` on top of the app view) rather than marking a region in the page, because
Chromium only honours `-webkit-app-region: drag` from a frame voltage owns — not from the
cross-origin iframes some apps render their toolbars in (e.g. Office documents). It is invisible
(1 px) until the cursor reaches the top-centre edge, then fades in as a translucent bar:

- **left:** a gear button that opens this app's settings in the Manager
  (`--voltage-edit-config=<profile>` deep link).
- **right:** window controls — DevTools (hidden when the app sets `"devTools": false`),
  About, minimize, maximize, close. For apps that also load the **zoom** plugin: − / live % / +.
- Hovering any button shows its label centred on the bar.

As an alternative, **Move mode** (context menu → *Move*, or `F10`) overlays the page with a
drag-to-move panel.

## Shortcuts

| Key | Action |
|---|---|
| `F10` | Toggle move mode |
| `F11` | Fullscreen · `Shift+F11` maximize/restore (frameless has no titlebar control) |
| `F12` | About panel · `Shift+F12` DevTools (detached) |

## Options (config dialog / `pluginConfig`)

| Key | Default | Effect |
|---|---|---|
| `radius` | `14` (0–24) | Corner radius of the app view |
| `shadow` | `true` | Drop shadow around the view |
| `shadowWidth` | `8` (2–8) | Shadow blur; the view is inset by a matching gutter |
| `resizable` | `true` | `false` locks the window size |
| `hideScrollbars` | `true` | Hide the page's scrollbars (wheel/touchpad still scroll) |
| `tintBackground` | `false` | Paint a tint over the page and clear its root backgrounds so the desktop shows through. Opt-in: only works on pages with a transparent own background (e.g. Home Assistant) and can strip backgrounds an app needs |
| `tint` | `#000000a6` | Tint colour (hex, incl. alpha). *Manual config only* — the dialog exposes just the on/off toggle |
| `suppressAppTitlebar` | `false` | Stop the app drawing its own titlebar/drag strip (e.g. Teams): a JS spoof hides the standalone/WCO signals at document start, and every page-declared `-webkit-app-region: drag` is neutralised |
| `dragZone` | `true` | The top drag strip (see above); disable for apps whose own titlebar already moves the window |
| `dragZoneLight` | `false` | Light theme for the drag strip (default dark) |
| `macButtonOrder` | `false` | macOS-style button order on the drag strip: window controls on the left with close outermost (traffic-light order), gear/About/DevTools/zoom on the right. Off = the classic layout |
| `showInTaskbar` | `false` | Off = the Manager writes `X-Voltage-Widget=true` into the `.desktop` launcher and the GNOME extension hides the app from the dash/dock. Enable for the rare widget you want docked |

Changing a value requires a rebuild (baked into the AppImage's `pluginConfig`).

## Files

`widget.js` (main-process module: window options, view geometry, tint injection, menu items) ·
`host.html` (the shadow page) · `drag-zone.html` + `drag-zone-preload.js` (the top strip) ·
`move-overlay.js` (move mode) · `no-titlebar.js` (titlebar suppression spoof) · `tint.css` ·
`config.html` (settings dialog).
