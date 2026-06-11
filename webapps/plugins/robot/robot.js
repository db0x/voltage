// robot plugin (main-process module). Auto-clicks one element (e.g. a <button> or a link
// <a>) on page load. Both the element type and the aria-label substring used to identify it are
// configurable per app (see config.html): the `target` dropdown picks the element type and
// `ariaLabel` is the matcher. The plugin injects the matching inject/*.js into the page after
// every load.

const path = require('path');
const fs = require('fs');

const TAG = '[robot-plugin]';

// The matcher used before this became configurable — kept as the fallback so existing installs
// (and a blank config) behave exactly as they did when the value was hardcoded.
const DEFAULT_ARIA_LABEL = '';
const DEFAULT_TARGET = 'button';

// One TEMPLATE per selectable element type, keyed by the `target` config value (which must match
// the <option value> entries in config.html). Each inject/<type>.js has a {{ariaLabel}} placeholder
// filled per-app before injection (so the files are not valid standalone JS). To add a new target
// type: drop inject/<type>.js, add it here, and add an <option> in config.html. Read once at load.
const TEMPLATES = {
    button: fs.readFileSync(path.join(__dirname, 'inject', 'button.js'), 'utf8'),
    link:   fs.readFileSync(path.join(__dirname, 'inject', 'link.js'),   'utf8'),
};

// The configured aria-label matcher, trimmed; falls back to the default for missing/blank config.
function resolveAriaLabel(config) {
    const raw = String(config?.ariaLabel ?? '').trim();
    return raw || DEFAULT_ARIA_LABEL;
}

// The configured target element type; falls back to the default for missing/unknown values.
function resolveTarget(config) {
    const t = String(config?.target ?? '');
    return TEMPLATES[t] ? t : DEFAULT_TARGET;
}

function attachPlugin(win, api) {
    const wc = api.webContents;
    const template = TEMPLATES[resolveTarget(api.config)];
    // JSON.stringify so any configured string becomes a safe JS string literal in the injected
    // script (handles quotes/backslashes, prevents injection into the page context).
    const script = template.replace(
        /\{\{ariaLabel\}\}/g,
        JSON.stringify(resolveAriaLabel(api.config))
    );

    const apply = () => {
        wc.executeJavaScript(script).catch(() => {});
    };

    wc.on('did-finish-load', apply);

    console.log(TAG, 'attached');
}

// configurable: the dialog's plugin chip shows a configure button opening config.html, where the
// target element type (button/link) and the aria-label matcher are set per app.
module.exports = { attachPlugin, configurable: true };
