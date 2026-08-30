const { test, expect } = require('@playwright/test')
const path = require('node:path')

// Unit tests for the robot plugin's pure config→script layer: resolveActions() normalises the stored
// config into the action list inject/actions.js runs, and buildScript() embeds that list in the page
// script. Plain Node assertions (no browser) because that is the whole decision layer — the config
// dialog's persistence is covered in plugins.spec.js, and actually running the injected script
// against a live page is an Electron-runtime path not exercised here.

const ROBOT = path.join(__dirname, '..', 'webapps', 'plugins', 'robot', 'robot.js')
const { resolveActions, buildScript } = require(ROBOT)

// Setup:    A config using the current list shape with three actions in a deliberate order.
// Action:   Normalise it.
// Expected: The order is preserved exactly — the whole point of the list is that actions build on
//           each other (fill a field, then submit it), so reordering would break the automation.
test('resolveActions keeps the configured order', () => {
  const actions = resolveActions({ actions: [
    { target: 'input',  identifier: 'user', value: 'thomas' },
    { target: 'input',  identifier: 'pass', value: 'secret' },
    { target: 'button', identifier: 'Anmelden' },
  ] })
  expect(actions.map(a => a.identifier)).toEqual(['user', 'pass', 'Anmelden'])
  expect(actions[2]).toEqual({ target: 'button', identifier: 'Anmelden' })
})

// Setup:    The two config shapes that predate the action list — a bare aria-label (what the plugin
//           stored when it could only click a button) and a flat input action.
// Action:   Normalise both.
// Expected: Each becomes a single-action list with the same meaning, so an app configured before
//           this plugin learned sequences keeps working without being edited.
test('resolveActions accepts the pre-list config shapes', () => {
  expect(resolveActions({ ariaLabel: 'Anmelden' }))
    .toEqual([{ target: 'button', identifier: 'Anmelden' }])

  expect(resolveActions({ target: 'input', elementId: 'io-ox-login-username', value: 'thomas' }))
    .toEqual([{ target: 'input', identifier: 'io-ox-login-username', value: 'thomas' }])
})

// Setup:    Entries that cannot be performed — an unknown target, and identifiers that are empty or
//           only whitespace.
// Action:   Normalise them alongside a valid entry.
// Expected: Only the valid one survives. An empty aria-label substring would match the FIRST button
//           on the page (includes('') is always true) and an empty id can never be found, so keeping
//           such an entry would either do nothing or click something arbitrary.
test('resolveActions drops entries that cannot be performed', () => {
  const actions = resolveActions({ actions: [
    { target: 'nope',   identifier: 'x' },
    { target: 'button', identifier: '   ' },
    { target: 'input',  value: 'no identifier' },
    { target: 'link',   identifier: 'Weiter' },
  ] })
  expect(actions).toEqual([{ target: 'link', identifier: 'Weiter' }])
})

// Setup:    One action of each kind, all carrying a value.
// Action:   Normalise them.
// Expected: Only the fill-in action keeps `value`; click and focus drop it. The dialog hides that
//           column for them but doesn't blank it, so a value left over from switching a row's action
//           would otherwise ride along into the injected script and the AppImage's baked config.
test('resolveActions keeps a value only for the action that uses one', () => {
  const actions = resolveActions({ actions: [
    { target: 'input',  identifier: 'user',     value: 'thomas' },
    { target: 'focus',  identifier: 'user',     value: 'left over' },
    { target: 'button', identifier: 'Anmelden', value: 'left over' },
    { target: 'link',   identifier: 'Weiter',   value: 'left over' },
  ] })
  expect(actions).toEqual([
    { target: 'input',  identifier: 'user' , value: 'thomas' },
    { target: 'focus',  identifier: 'user' },
    { target: 'button', identifier: 'Anmelden' },
    { target: 'link',   identifier: 'Weiter' },
  ])
})

// Setup:    A focus action.
// Action:   Build the injected script.
// Expected: The page script recognises `focus` as an id-addressed target and calls focus() on it —
//           this is what keeps the target list in robot.js and the branches in inject/actions.js
//           from drifting apart, which would leave a configurable action that silently does nothing.
test('the injected script can perform the focus action', () => {
  const script = buildScript({ actions: [{ target: 'focus', identifier: 'user' }] })
  expect(script).toContain("BY_ID = ['input', 'focus']")
  expect(script).toContain('element.focus()')
})

// Setup:    An entry whose identifier and value carry surrounding whitespace.
// Action:   Normalise it.
// Expected: The identifier is trimmed (getElementById matches exactly, and a stray space would widen
//           an aria-label substring match) while the value is kept verbatim — spaces in a value may
//           be intentional, and it is written rather than matched.
test('resolveActions trims the identifier but keeps the value verbatim', () => {
  expect(resolveActions({ actions: [{ target: 'input', identifier: '  user  ', value: '  x  ' }] }))
    .toEqual([{ target: 'input', identifier: 'user', value: '  x  ' }])
})

// Setup:    An empty config, and one whose action list is empty.
// Action:   Normalise.
// Expected: An empty list either way — a freshly added, unconfigured plugin must do nothing at all
//           rather than fall back to some default action.
test('resolveActions yields nothing for an unconfigured plugin', () => {
  expect(resolveActions({})).toEqual([])
  expect(resolveActions(undefined)).toEqual([])
  expect(resolveActions({ actions: [] })).toEqual([])
})

// Setup:    A two-action config.
// Action:   Build the injected script.
// Expected: The actions travel as a JSON string literal that the page script parses, and no
//           placeholder survives — an unreplaced {{...}} would be a syntax error in the page and the
//           injection would fail silently (executeJavaScript rejections are swallowed).
test('buildScript embeds the actions as parseable JSON with no placeholder left', () => {
  const script = buildScript({ actions: [
    { target: 'input',  identifier: 'user', value: 'thomas' },
    { target: 'button', identifier: 'Anmelden' },
  ] })
  expect(script).not.toContain('{{')

  const embedded = script.match(/JSON\.parse\((".*?")\);/)
  expect(embedded).not.toBeNull()
  expect(JSON.parse(JSON.parse(embedded[1]))).toEqual([
    { target: 'input',  identifier: 'user', value: 'thomas' },
    { target: 'button', identifier: 'Anmelden' },
  ])
})

// Setup:    A value containing quotes, a backslash and a newline — i.e. exactly what would terminate
//           a naive string literal early and let the rest run as code.
// Action:   Build the injected script and read the embedded payload back.
// Expected: It round-trips as data. Double-encoding (JSON inside a JS string literal) is what keeps a
//           configured value from ever becoming executable code in the page.
test('buildScript keeps values that look like code as data', () => {
  const nasty = '";alert(1);//\\\n'
  const script = buildScript({ actions: [{ target: 'input', identifier: 'x', value: nasty }] })

  const embedded = script.match(/JSON\.parse\((".*?")\);/)
  expect(JSON.parse(JSON.parse(embedded[1]))[0].value).toBe(nasty)
  expect(script).not.toContain('alert(1);//\\\n')
})
