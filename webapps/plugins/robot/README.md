# robot plugin

Automates a **sequence** of interactions on page load — the things you'd otherwise click or type
every single time an app opens. Typical use: fill in a username, focus the password field, then click
the login button.

The actions run strictly **in the configured order**: each one waits for its own element to appear
before the next begins. A guard flag on `window` makes the whole sequence run once per page instance,
so an in-page navigation can't replay it.

It also offers an opt-in **keep-alive** (see below) that keeps the session it just logged into from
going idle.

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

## Keep-alive

Teams (and anything else that derives presence from activity) only counts what happens **inside its
own window**: sitting at the machine and working in another window looks exactly like having left,
and the status flips to "Abwesend"/"Away". With the keep-alive enabled, the plugin feeds a small
burst of user activity into the app's page every *n* minutes (default 5, range 1–30).

It is **off by default** and independent of the action list — an app may enable only the keep-alive
and configure no action at all.

Every tick sends the burst through **two channels**, because each one fails where the other holds:

| Channel | What it is | Fails when |
|---|---|---|
| `webContents.sendInputEvent` | a real Chromium mouse move — `isTrusted`, indistinguishable from the actual mouse | keyboard input needs window focus, so only the mouse move goes this way |
| `inject/keepalive.js` | `pointermove` + `mousemove` + a Shift press the page dispatches on itself | `isTrusted` is false, so a tracker that checks it ignores them |

Whichever signal the app's activity tracker listens to, one of the two reaches it.

**It stays out of the way.** The trusted mouse move really does move the page's pointer, so it is
aimed at wherever the real cursor already is whenever the cursor sits inside this window — hover
state and open tooltips survive the nudge. Only when the cursor is elsewhere does the pointer get
parked a few pixels into the content. The position shifts by a pixel on alternating ticks: a tracker
that compares coordinates reads two identical moves as no movement at all. The only key pressed is
**Shift** — it never inserts text and is not a shortcut on its own, so a burst landing in a focused
field changes nothing.

The timer runs in the **main process**, so it survives page loads and keeps firing while the window
is unfocused or minimised, where a renderer timer would be throttled to a crawl. It is cleared when
the window closes.

> This changes what an app reports about you: your status stays "available" while the app is running,
> whether or not you are actually at the machine. That is the point of the feature — just know that
> it is the app's presence you are steering, and switch it off per app rather than everywhere.

## Config (`pluginConfig`)

```jsonc
"plugins/robot/robot.js": {
    "actions": [
        { "target": "input",  "identifier": "login-user", "value": "thomas" },
        { "target": "focus",  "identifier": "login-pass" },
        { "target": "button", "identifier": "Anmelden" }
    ],
    "keepAlive": true,
    "keepAliveMinutes": 5
}
```

- `target` — `"button"` (default) | `"link"` | `"input"` | `"focus"`
- `identifier` — aria-label substring for the click targets, exact id for `input` and `focus`.
  Trimmed.
- `keepAlive` — `true` turns the keep-alive on; absent or `false` means it never runs.
- `keepAliveMinutes` — interval in minutes, clamped to 1–30; anything unreadable falls back to 5.
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
| `keepalive.js` | the keep-alive: settings, the timer, and the trusted mouse move |
| `inject/keepalive.js` | the page-side activity burst — plain JS, no placeholders, run once per tick |
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
- `tests/robot-keepalive.spec.js` — the keep-alive: staying off unless enabled, the interval default
  and clamping, the burst's harmlessness, plus the dialog's gating and config round-trip.
- `tests/plugins.spec.js` — Manager e2e: the action rows round-trip into `pluginConfig` in row order,
  the value column shows only for the fill-in action, and an untouched trailing row is not
  persisted.

The injected scripts themselves run in a live page and are not exercised by the tests, and neither
is the keep-alive's actual event delivery (`sendInputEvent` on a live window).
