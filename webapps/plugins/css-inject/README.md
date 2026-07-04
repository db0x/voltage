# css-inject plugin

Injects a per-app stylesheet into the wrapped page — recolour a site via its CSS custom properties,
hide elements, or append arbitrary hand-written CSS. Configured per app in the Manager (gear dialog);
values live in `pluginConfig` and are **baked at build time**, so changes require a rebuild.

## Options (config dialog / `pluginConfig`)

| Key | Effect |
|---|---|
| `rules` | Repeatable list of `{ varName, color }` overrides. Each sets one CSS custom property (e.g. `--color-bg-primary`) on `:root, body` with `!important`, so it cascades to every rule that resolves it via `var()` — one declaration restyles the whole site. Names are validated (`--ident`), colours must be hex (`#RGB[A]`/`#RRGGBB[AA]`, the Coloris picker's output); invalid rows are dropped rather than injected |
| `customCss` | Free-text CSS appended **verbatim** after the structured rules (later rules win at equal specificity). This is the user hand-writing CSS for their own wrapped app, so arbitrary CSS is the point — no validation beyond trimming |
| `removeFocusRing` | Opt-in (default off): suppresses Chromium's keyboard focus ring via `:focus-visible { outline: none !important; }`. A deliberate accessibility trade-off, scoped to the keyboard ring only |

Selector tip: for an element with several classes, chain them **without spaces**
(`.launcher.ms-16.me-16`), or use DevTools → *Copy selector*. `Shift+F12` opens DevTools inside any
voltage app to inspect the target element.

## Injection model — why it never flashes

The stylesheet is injected at **document-start, before first paint**, so a `display:none` target
never flashes visible for a frame (the FOUC a post-load `insertCSS` had). Delivery is per frame:

- **Main frame:** the CSS rides into the preload via `additionalArguments` (`process.argv`) — in
  hand synchronously before any page script runs, no IPC race.
- **Sub-frames, including cross-origin OOPIFs** (e.g. the Office/OnlyOffice editor frame, which
  never receives `additionalArguments`): the preload fetches the same CSS from the main process via
  a synchronous IPC (`voltage:css-inject`), mirroring the per-frame `should-block-close` query.

`webFrame.insertCSS` persists across SPA soft-navigations; the preload re-runs (re-injecting) on
every full document load.

## Scope & limits

- **All frames are styled.** Broad selectors (`body`, `*`, generic class names) and the variable
  overrides (`:root, body { … }`) apply inside embedded iframes too — prefer specific ids/classes
  when hiding elements so nothing leaks into frame content.
- **Shadow DOM is not pierced** — document stylesheets don't cross shadow roots, so elements inside
  a `#shadow-root` (web components) cannot be styled or hidden. This is the remaining boundary.
- Purely cosmetic: no scripts are injected, only CSS.
