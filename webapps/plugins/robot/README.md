# robot plugin

Automates a **sequence** of interactions on page load — the things you'd otherwise click or type
every single time an app opens. Typical use: fill in a username, focus the password field, then click
the login button.

The actions run strictly **in the configured order**: each one waits for its own element to appear
before the next begins. A guard flag on `window` makes the whole sequence run once per page instance,
so an in-page navigation can't replay it.

## Using it

1. Add **robot** to the app's plugins in the Manager's create/edit dialog.
2. Open its gear dialog and add one row per action. Row order is execution order.
3. Rebuild the AppImage (`pluginConfig` is baked at build time).

## Actions

| Action | Finds | Identified by | Then |
|---|---|---|---|
| Click button | `<button>` | substring of `aria-label`, case-insensitive | clicks it |
| Click link | `<a>` | substring of `aria-label`, case-insensitive | clicks it |
| Fill in text | any element with that id | the **exact** id, case-sensitive | writes `value` into it |
| Set focus | any element with that id | the **exact** id, case-sensitive | calls `focus()` on it |

The click actions match **only** on `aria-label`, never on visible text — identification stays
independent of wording and translation. The fill and focus actions use `getElementById` instead,
because a form field's `aria-label` is often missing or repeated across a form while its id is what
markup reliably provides.

Each action polls every 500 ms for up to 30 s (60 attempts). That polling **is** the "is it in the
DOM yet" check — an action only fires once its element actually exists, which is what makes this work
on pages that render their form late.

If an element never turns up, the **whole chain stops** rather than skipping ahead: the steps are
ordered because they build on each other, so continuing past a missing one would act on a
half-prepared page. The reason is logged to the page console under `[robot-plugin]`.

## Config (`pluginConfig`)

```jsonc
"plugins/robot/robot.js": {
    "actions": [
        { "target": "input",  "identifier": "login-user", "value": "thomas" },
        { "target": "focus",  "identifier": "login-pass" },
        { "target": "button", "identifier": "Anmelden" }
    ]
}
```

- `target` — `"button"` (default) | `"link"` | `"input"` | `"focus"`
- `identifier` — aria-label substring for the click targets, exact id for `input` and `focus`.
  Trimmed.
- `value` — only used by `input`; written **verbatim**, not trimmed, since surrounding spaces may be
  intentional. An empty value is allowed on purpose: clearing a field the page pre-filled is a
  legitimate goal. For every other action the value is dropped during normalisation, so a leftover
  from switching a row's action never reaches the page or the baked config.

An entry without an identifier is dropped rather than injected — an empty aria-label substring
matches the *first* button on the page (`includes('')` is always true) and an empty id can never be
found, so such an entry is at best useless and at worst clicks something arbitrary.

**Older config shapes still work.** Before this plugin could do more than one thing, a single action
was stored flat at the top level (`{ "ariaLabel": "Anmelden" }`, later
`{ "target": "input", "elementId": …, "value": … }`). Both are normalised into a one-action list at
runtime, so an app configured back then needs no edit. The dialog only writes the `actions` shape, so
re-saving such an app migrates it.

> **Credentials:** `value` is stored in plain text in `build.private.*.json` **and baked into the
> AppImage's package.json**. Fine for a username; don't put a password there and hand that AppImage
> around.

## Filling an input: why it dispatches events

Writing `field.value = ...` alone updates what the user sees but is invisible to the page: nothing
listening for `input`/`change` reacts, and validation or "is the form complete" state never updates.
Worse, a framework that controls the input (React and friends) shadows the `value` property on the
element instance, keeps its own state, and overwrites the field again on its next render.

`inject/actions.js` therefore assigns through the prototype's **native** value setter and then
dispatches `input` and `change` (both bubbling) — the same signals a real keystroke produces.

## Files

| File | Role |
|---|---|
| `robot.js` | main-process module: normalises the config into an action list, fills the template, injects on load |
| `inject/actions.js` | the injected page script — a **template**, not standalone JS (see below) |
| `config.html` | the per-app config dialog |

`inject/actions.js` carries an `{{actions}}` placeholder that `buildScript()` replaces with the
normalised list. It is embedded as a JSON **string literal** and parsed in the page, so a configured
value is only ever data and can never become executable code — whatever was typed into the dialog.

There is one injected script rather than one per action type: independent scripts would each poll on
their own and race, which is exactly what ordered execution rules out.

To add an action type: extend `findElement`/`performAction` in `inject/actions.js`, add the id to
`TARGETS` in `robot.js` (and to `TARGETS_WITH_VALUE` if it needs a value), and add an `<option>` to
the row template in `config.html`. A field that only some actions use gets a
`data-config-field-visible-if="target=…"` so it hides itself in the rows that don't.

## Tests

- `tests/robot.spec.js` — node-level: ordering, the legacy config shapes, dropping unperformable
  entries, keeping a value only where it's used, trimming rules, and the data-not-code embedding
  guard.
- `tests/plugins.spec.js` — Manager e2e: the action rows round-trip into `pluginConfig` in row order,
  the value column shows only for the fill-in action, and an untouched trailing row is not
  persisted.

The injected script itself runs in a live page and is not exercised by the tests.
