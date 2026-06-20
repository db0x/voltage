// css-inject plugin (main-process module). Lets an app override one or more CSS custom properties
// of the page it wraps — a per-app list of (variable name → colour) rules configured in the manager
// (config.html). Purely cosmetic: it can recolour the wrapped site through its own theme variables,
// but cannot reach into cross-origin iframes (same boundary limitation as no-select and the other
// page-injected plugins — the renderer can't apply CSS across that boundary).
//
// Why insertCSS (not executeJavaScript with a <style>): insertCSS survives SPA soft-navigations
// without re-injection, so the styling stays applied as the user moves around the app. We still
// re-apply on every full navigation (did-finish-load), because a full document load drops the
// previously inserted stylesheet.
//
// Why override the variable (not individual rules): setting e.g. --color-bg-primary once cascades
// to every rule that resolves var(--color-bg-primary), so a single declaration restyles the whole
// site. We set it on both :root and body with !important so it wins regardless of where the page
// declares the variable (Mastodon, for instance, sets it on :root).

const TAG = '[css-inject-plugin]'

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

// Builds the injected stylesheet from the configured variable overrides and the optional
// focus-ring suppression, or null when neither is active (then the plugin attaches but injects
// nothing). The variable overrides share one :root, body block — each overridden variable
// cascades to every rule that resolves it via var().
function buildCss(config) {
  const parts = []
  const rules = resolveRules(config)
  if (rules.length) {
    const decls = rules.map(r => `${r.name}: ${r.color} !important;`).join(' ')
    parts.push(`:root, body { ${decls} }`)
  }
  if (resolveRemoveFocusRing(config)) parts.push(FOCUS_RING_OFF_CSS)
  return parts.length ? parts.join('\n') : null
}

function attachPlugin(win, api) {
  // Inject into the APP's webContents — api.webContents is the window's own webContents normally,
  // but the inset WebContentsView when another plugin (e.g. widget) runs the app in view mode.
  // win.webContents would hit the empty host/shadow page in that case → the CSS silently never
  // lands. See window.js loadPlugins() for the api.webContents contract.
  const wc  = api.webContents
  const css = buildCss(api.config)

  if (!css) {
    console.log(TAG, 'attached (no valid variable/colour configured)')
    return
  }

  // Re-apply after every full load: insertCSS persists across in-page navigation but a full
  // document load replaces the page and drops the inserted stylesheet.
  const apply = () => { wc.insertCSS(css).catch(() => {}) }
  wc.on('did-finish-load', apply)
  console.log(TAG, 'attached')
}

// configurable: the chip's configure button opens config.html, where the variable name and colour
// are set per app.
module.exports = { attachPlugin, configurable: true, buildCss }
