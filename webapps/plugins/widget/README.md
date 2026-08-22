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

- **far left:** the app's own icon (same resolver the About panel uses) — opt-in via the `dragZoneIcon`
  config toggle (default off). Purely identifying — not a button.
- **left:** a gear button that opens this app's settings in the Manager
  (`--voltage-edit-config=<profile>` deep link). Shown only when the Voltage repo the app was built
  from is actually reachable on this machine (the baked `appRoot` resolves to a checkout) — on a
  handed-over AppImage the click could only fail silently, so the button is hidden entirely.
- **right:** window controls — DevTools (hidden when the app sets `"devTools": false`),
  About, minimize, maximize, close. For apps that also load the **zoom** plugin: − / live % / +.
  For apps that also load the **only-office** plugin: a home button (the only-office glyph) that
  routes the app back to the backend's document list (the plugin's configured `baseUrl`, so
  reverse-proxy path prefixes like `http://black/relay` work too), which the editor page has no way
  back to. It appears only while an editor page (`<baseUrl>/edit/…`) is open; on the list itself it
  would be a no-op, so it is hidden there (toggled live on every navigation).
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
| `softwareVideoDecode` | `false` | Force software (non-GPU) video decode for this app. *Manual config only — no dialog toggle*: a workaround for a specific Electron conflict, not a general-purpose knob. See below |
| `shadow` | `true` | Drop shadow around the view |
| `shadowWidth` | `8` (2–8) | Shadow blur; the view is inset by a matching gutter |
| `resizable` | `true` | `false` locks the window size |
| `aspectRatioLock` | `false` | Constrain resizing to the ratio below. No effect while `resizable` is `false`. Enforced by hand on every resize (height as the reference, width follows) rather than relying solely on `setAspectRatio`, since frameless windows often don't get WM aspect-ratio hints honoured on Linux/Wayland. **Doesn't reliably hold during a native, OS-driven interactive resize** (confirmed on Wayland/Mutter — see below); for a ratio that has to hold, use `resizable: false` with a fixed size instead |
| `aspectRatio` | `16:9` | Free-text ratio used when `aspectRatioLock` is on, as `width:height` (e.g. `16:9`, `4:3`, `12:5`). Malformed/missing values fall back to `16:9`. Also applied once on open, so a locked window starts at the right ratio even if its saved/default size doesn't match |
| `preciseAspectRatio` | `false` | Apply the ratio to the content area (window minus the shadow gutter) instead of the window itself. No effect without `aspectRatioLock`, and currently only takes effect when `aspectRatio` is exactly `4:3`. See below |
| `hideScrollbars` | `true` | Hide the page's scrollbars (wheel/touchpad still scroll) |
| `tintBackground` | `false` | Paint a tint over the page and clear its root backgrounds so the desktop shows through. Opt-in: only works on pages with a transparent own background (e.g. Home Assistant) and can strip backgrounds an app needs |
| `tint` | `#000000a6` | Tint colour (hex, incl. alpha). *Manual config only* — the dialog exposes just the on/off toggle |
| `suppressAppTitlebar` | `false` | Stop the app drawing its own titlebar/drag strip (e.g. Teams): a JS spoof hides the standalone/WCO signals at document start, and every page-declared `-webkit-app-region: drag` is neutralised |
| `dragZone` | `true` | The top drag strip (see above); disable for apps whose own titlebar already moves the window |
| `dragZoneIcon` | `false` | Show the app's own icon at the far left of the drag strip. No effect while `dragZone` is `false` |
| `dragZoneLight` | `false` | Light theme for the drag strip (default dark) |
| `macButtonOrder` | `false` | macOS-style button order on the drag strip: window controls on the left with close outermost (traffic-light order), gear/About/DevTools/zoom on the right. Off = the classic layout |
| `showInTaskbar` | `false` | Off = the Manager writes `X-Voltage-Widget=true` into the `.desktop` launcher and the GNOME extension hides the app from the dash/dock. Enable for the rare widget you want docked |

Changing a value requires a rebuild (baked into the AppImage's `pluginConfig`).

### Rounded corners vs. hardware-accelerated video (`softwareVideoDecode`)

The app view's rounded corners (`radius`) use Electron's `WebContentsView.setBorderRadius`, a
GPU-composited clip. Observed with a Selkies-streamed container app (ScummVM): a page whose content is
itself **hardware-video-decoded** (Selkies streams the remote desktop as H.264 video, not image tiles)
came out visibly corrupted/garbled with `radius` > 0, and rendered cleanly with `radius: 0` — the
rounded clip and the video's hardware overlay path don't compose correctly together. This is an
Electron/Chromium limitation, not something the plugin can configure around client-side.

`softwareVideoDecode: true` forces Chromium to decode video in software instead
(`--disable-accelerated-video-decode`, set process-wide in `main.js` — see its comment there) *before*
any window is created, so rounded corners can stay on without the corruption. Costs some CPU; a single
modest video-resolution stream won't notice. **Every Voltage app is its own process/AppImage**, so this
only ever affects the one app whose own config sets it — never other apps, even ones built from the
same repo. Only worth setting for an app that (a) uses rounded widget corners AND (b) shows
GPU-decoded video; forcing it elsewhere just costs CPU for nothing (e.g. a real video-calling app
would lose a legitimate hardware-decode benefit).

### Content-exact ratio with a shadow on (`preciseAspectRatio`)

`aspectRatioLock` enforces the ratio on the **window**. With a shadow on, the app's actual content
area is smaller than the window by the shadow gutter (`margin`, both sides) — a constant pixel amount,
not a proportional one, so it very slightly skews the content area's own ratio away from the window's
even while the window itself is exact (e.g. a 4:3-locked window with a small content area can end up
content-rendering at ~1.34:1 instead of exactly 4:3). Usually imperceptible, but visible with a page
that renders at a fixed aspect ratio and refuses to stretch to fill a slightly-off container (observed
with a Selkies-streamed ScummVM container: the video content stayed pinned to its own exact ratio,
leaving a hairline gap on one axis).

`preciseAspectRatio: true` makes `enforceRatio` (`widget.js`) target the content area instead: subtract
the shadow gutter from height before applying the ratio, add it back to get the window width. With
shadow off, `margin` is 0 and the formula is identical to the plain path — so the flag is harmless to
leave on generally, it just has nothing to correct. **Currently gated to exactly `aspectRatio: "4:3"`**
— not because the math is 4:3-specific (it isn't), but because that's the only ratio this has actually
been exercised against; broadening the check in `attachPlugin` to other ratios should work but hasn't
been verified.

### Live resize with a locked ratio: not reliable on Wayland/Mutter

`enforceRatio`'s `win.setContentBounds()` calls only reliably reach the screen for a resize *we*
triggered (a launch-time correction, a config change). During a **native, OS/compositor-driven
interactive resize** — the user dragging a window edge — they don't: confirmed on Wayland/Mutter, the
compositor owns that gesture and can silently decline to apply our correction to the actual screen,
even though Electron's own bounds bookkeeping (`getContentBounds()`) reports it as applied. This is the
same underlying limitation as `setAspectRatio()` itself not working (see above).

A custom resize-grip overlay (a small corner `WebContentsView`, dragged via pointer capture so the app
— not the OS — owns the whole gesture, sidestepping the compositor's interactive-resize protocol
entirely) was built and tried as a fix, including turning native resize off (`win.setResizable(false)`)
so it wouldn't compete with the grip for the same corner screen space. Neither held up in practice —
the window was still freely resizable by dragging its edge, on the actual target machine, no correction
applied. The exact reason wasn't pinned down (this needs a real interactive Wayland resize to debug,
which isn't reproducible through Electron's own test APIs — see the plugin's git history around this
if picking it back up). Reverted rather than shipped half-working.

**For a ratio that has to hold, use `resizable: false` with a fixed size instead of `aspectRatioLock` +
live resizing** — no compositor interaction involved, so it's unconditionally reliable. Pick a size
where `width - 2×margin` and `height - 2×margin` are already in the ratio you want (`margin` is 0 with
`shadow: false`, otherwise `SHADOW_OFFSET(3) + shadowWidth + 1` on each side).

## Files

`widget.js` (main-process module: window options, view geometry, tint injection, menu items) ·
`host.html` (the shadow page) · `drag-zone.html` + `drag-zone-preload.js` (the top strip) ·
`move-overlay.js` (move mode) · `no-titlebar.js` (titlebar suppression spoof) · `tint.css` ·
`config.html` (settings dialog).
