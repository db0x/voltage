// robot plugin (main-process module). Automates a SEQUENCE of interactions on page load — clicking
// a <button> or a link <a>, filling a text <input>, and focusing an element — running them strictly
// in order, each one waiting for its own element before the next begins. Typical use: fill a
// username, then click the login button.
//
// The actions are configured per app (see config.html) as a list; each entry names a `target` (what
// to do), an `identifier` (how to find the element) and, for the input target, the `value` to write.
// The plugin injects inject/actions.js into the page after every load.

const path = require('path');
const fs = require('fs');

const TAG = '[robot-plugin]';

// Fallback target for an entry that names none, and the set of targets inject/actions.js can
// actually perform. Anything else is dropped during normalisation rather than injected, so a typo
// can't produce an action the page script silently ignores mid-sequence.
const DEFAULT_TARGET = 'button';
const TARGETS = ['button', 'link', 'input', 'focus'];

// The only target that carries a value; the others are pure interactions. Kept explicit so a stale
// value left behind in the dialog (switching a row from "fill in" to "focus" hides the field but
// doesn't blank it) never reaches the injected script, let alone the AppImage's baked config.
const TARGETS_WITH_VALUE = ['input'];

// The page script, read once at load. A single template (not one per target) because the actions
// must run in order — see the comment at the top of inject/actions.js.
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'inject', 'actions.js'), 'utf8');

// Normalises one configured entry, or null if it can't be performed. The identifier is trimmed: for
// input it goes to getElementById, which matches exactly, and for button/link a stray space would
// widen the aria-label substring match. The value is NOT trimmed — surrounding spaces may be
// intentional, and unlike an identifier it is never matched against anything, just written.
// An entry without an identifier is dropped: an empty aria-label substring matches the FIRST button
// on the page (includes('') is always true) and an empty id can never be found, so such an entry is
// at best useless and at worst clicks something arbitrary.
function normalizeAction(raw) {
    const target = TARGETS.includes(raw?.target) ? raw.target : (raw?.target ? null : DEFAULT_TARGET);
    if (!target) return null;

    // `identifier` is the current field name; ariaLabel/elementId are the ones used before this
    // plugin gained a target dropdown and a list, still read so configs written back then keep
    // working untouched.
    const identifier = String(raw?.identifier ?? raw?.ariaLabel ?? raw?.elementId ?? '').trim();
    if (!identifier) return null;

    const action = { target, identifier };
    if (TARGETS_WITH_VALUE.includes(target)) {
        action.value = String(raw?.value ?? '');
    }
    return action;
}

// The configured actions, in order, as inject/actions.js expects them.
// Two accepted config shapes: the current `actions` array, and a single flat action at the top level
// (what the plugin stored before it could do more than one thing). The flat form is normalised into
// a one-element list here, so an app configured before this change needs no edit.
function resolveActions(config) {
    const raw = Array.isArray(config?.actions) ? config.actions : [config];
    return raw.map(normalizeAction).filter(Boolean);
}

// Fills the template with the normalised actions. JSON.stringify runs twice on purpose: once to turn
// the array into JSON, once more to make that JSON a *string literal* in the injected source, which
// the page script then JSON.parse()s. So configured values are only ever data — they cannot become
// executable code in the page context, whatever was typed into the dialog.
function buildScript(config) {
    return TEMPLATE.replace(
        /\{\{actions\}\}/g,
        JSON.stringify(JSON.stringify(resolveActions(config)))
    );
}

function attachPlugin(win, api) {
    const wc = api.webContents;
    const script = buildScript(api.config);

    const apply = () => {
        wc.executeJavaScript(script).catch(() => {});
    };

    wc.on('did-finish-load', apply);

    console.log(TAG, 'attached');
}

// configurable: the dialog's plugin chip shows a configure button opening config.html, where the
// action list is edited per app.
// resolveActions/buildScript are exported for the unit tests (tests/robot.spec.js) — together they
// are the whole decision layer (config normalisation + template filling), testable without an
// Electron window.
module.exports = { attachPlugin, resolveActions, buildScript, configurable: true };
