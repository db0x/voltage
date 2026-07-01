// css-inject plugin (main-process module). Lets an app override one or more CSS custom properties
// of the page it wraps — a per-app list of (variable name → colour) rules plus a free-text CSS
// block, configured in the manager (config.html). Purely cosmetic: it recolours or hides parts of the
// wrapped site. The stylesheet is injected into EVERY frame (see preload.js), so it reaches elements
// the app renders inside iframes too — including the cross-origin out-of-process editor frame of
// Office/OnlyOffice. It still cannot pierce a shadow DOM (document stylesheets don't cross shadow
// roots) — the remaining boundary for shadow-encapsulated elements.
//
// Injection timing — document-start, not post-load. The stylesheet does NOT ride in through an
// attachPlugin/did-finish-load insertCSS: that fires after first paint, so a `display:none` rule let
// the target element flash visible for a frame (FOUC) before it vanished. Instead the preload calls
// webFrame.insertCSS() synchronously at document-start — before the page paints. Delivery to the
// preload is per-frame: the MAIN frame reads the CSS from additionalArguments (preloadArgs() below →
// process.argv); SUB-frames (incl. cross-origin OOPIFs, which never get additionalArguments) fetch the
// same CSS from main via a synchronous voltage:css-inject IPC (window.js publishes it per app). The CSS
// is fixed at window-creation time (per-app config). webFrame.insertCSS persists across SPA soft-
// navigations, and the preload re-runs (re-injecting) on every full document load.
//
// Why override the variable (not individual rules): setting e.g. --color-bg-primary once cascades
// to every rule that resolves var(--color-bg-primary), so a single declaration restyles the whole
// site. We set it on both :root and body with !important so it wins regardless of where the page
// declares the variable (Mastodon, for instance, sets it on :root).

// Prefix of the additionalArgument that carries the injected stylesheet to the preload. Must match
// the reader in preload.js. The CSS is URI-encoded after this prefix (argv is a flat string list).
const PRELOAD_ARG = '--voltage-css-inject='

// CSS custom-property name pattern: two leading dashes then identifier chars. Validating before
// interpolation keeps a stray config value from breaking out of the declaration (CSS injection),
// since the value is built into a stylesheet string and run via insertCSS.
const VAR_NAME_RE = /^--[A-Za-z0-9_-]+$/

// Accepted colour value: a #RGB / #RGBA / #RRGGBB / #RRGGBBAA hex string — exactly what the Coloris
// picker (format 'hex', alpha:true) produces. Anything else is rejected so we never inject an
// arbitrary string as a property value.
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

// Suppresses Chromium's default keyboard focus ring — the orange system outline the UA paints on
// :focus-visible when navigating by keyboard. Opt-in (removeFocusRing toggle, default off) because
// it removes the page's own keyboard-focus affordance, a deliberate accessibility trade-off the
// user enables per app. Scoped to :focus-visible so it only touches the keyboard ring, leaving any
// explicit :focus styling the site defines intact.
const FOCUS_RING_OFF_CSS = ':focus-visible { outline: none !important; }'

// The toggle stores a real boolean (the manager's plugin-config host writes the toggle state), but
// a hand-edited config could carry the string "true"; accept both, reject everything else.
function resolveRemoveFocusRing(config) {
  return config?.removeFocusRing === true || config?.removeFocusRing === 'true'
}

// Normalises the configured variable name: trims, and prepends the leading "--" if the user typed
// the bare name (e.g. "color-bg-primary"). Returns null when empty or still invalid after that.
function resolveVarName(raw) {
  if (typeof raw !== 'string') return null
  let name = raw.trim()
  if (!name) return null
  if (!name.startsWith('--')) name = `--${name.replace(/^-+/, '')}`
  return VAR_NAME_RE.test(name) ? name : null
}

// Validates the configured colour string against COLOR_RE. Returns null when missing/malformed.
function resolveColor(raw) {
  if (typeof raw !== 'string') return null
  const color = raw.trim()
  return COLOR_RE.test(color) ? color : null
}

// Reads the free-text custom CSS block (config.customCss) and returns it verbatim, or null when
// empty. Unlike the variable/colour rules — which are validated so a stray config value can't break
// out of a controlled declaration — this block is injected as-is: it is the user hand-writing CSS
// for their own wrapped app, so arbitrary CSS is the whole point. The trust boundary is the same as
// any other field in the user's own config; we only trim and drop it when blank.
function resolveCustomCss(raw) {
  if (typeof raw !== 'string') return null
  const css = raw.trim()
  return css ? css : null
}

// Reads the configured overrides into a clean [{ name, color }] list. The config stores them under
// `rules` (an array of { varName, color }); a single legacy { varName, color } at the top level is
// accepted as a one-entry list so configs written before the multi-row dialog still work. Rows with
// a missing/invalid name or colour are dropped (a half-filled row does no harm).
function resolveRules(config) {
  const raw = Array.isArray(config?.rules)
    ? config.rules
    : (config?.varName || config?.color) ? [{ varName: config.varName, color: config.color }] : []
  const rules = []
  for (const entry of raw) {
    const name  = resolveVarName(entry?.varName)
    const color = resolveColor(entry?.color)
    if (name && color) rules.push({ name, color })
  }
  return rules
}

// Builds the injected stylesheet from the configured variable overrides, the optional focus-ring
// suppression and the free-text custom CSS block, or null when none is active (then the plugin
// attaches but injects nothing). The variable overrides share one :root, body block — each
// overridden variable cascades to every rule that resolves it via var(). The custom CSS is appended
// last so it has the final say (later rules win at equal specificity), matching its purpose as a
// user-authored override on top of the structured fields.
function buildCss(config) {
  const parts = []
  const rules = resolveRules(config)
  if (rules.length) {
    const decls = rules.map(r => `${r.name}: ${r.color} !important;`).join(' ')
    parts.push(`:root, body { ${decls} }`)
  }
  if (resolveRemoveFocusRing(config)) parts.push(FOCUS_RING_OFF_CSS)
  const customCss = resolveCustomCss(config?.customCss)
  if (customCss) parts.push(customCss)
  return parts.length ? parts.join('\n') : null
}

// Early plugin hook (collected by window.js before the window is created, like windowOptions/
// viewConfig). Returns the additionalArguments this plugin contributes to the app's webPreferences:
// a single --voltage-css-inject=<encoded-css> entry the preload reads and injects at document-start,
// or [] when nothing is configured (the arg is then absent and the preload no-ops). URI-encoding is
// required because the CSS is arbitrary text and argv entries are plain strings — the preload
// decodes it back. Passed the per-app plugin config (window.js resolves pkg.pluginConfig[rel]).
function preloadArgs(config) {
  const css = buildCss(config)
  return css ? [`${PRELOAD_ARG}${encodeURIComponent(css)}`] : []
}

// configurable: the chip's configure button opens config.html, where the overrides + custom CSS are
// set per app. No attachPlugin: injection happens entirely at document-start via preloadArgs (see
// the timing note at the top), so this plugin only contributes an early hook, not a post-load one.
module.exports = { preloadArgs, configurable: true, buildCss, PRELOAD_ARG }
