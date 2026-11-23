const { test, expect } = require('@playwright/test')
const { promptFromArgv, promptUrl } = require('../src/prompt-arg')
const { expandConfig } = require('../scripts/build')

// Unit tests for launching an app with a prompt (`vClaude --prompt="…"`, src/prompt-arg.js). Pure
// logic, no Electron: argv parsing, the template → URL step, and the build baking the template into
// the AppImage. The wiring in app-window.js (load that URL instead of the start page) needs a real
// packaged app and is not exercised here.

// Setup:    An AppImage argv as the runtime sees it — binary, Chromium switches, the prompt flag.
// Action:   Extract the prompt.
// Expected: The text after `--prompt=`, spaces and all — the shell has already removed the quotes.
test('promptFromArgv reads --prompt=text', () => {
  expect(promptFromArgv(['/tmp/vClaude', '--no-sandbox', '--prompt=Erkläre mir Monaden'])).toBe('Erkläre mir Monaden')
})

// Setup:    The two-token spelling, as typed without an equals sign.
// Action:   Extract the prompt.
// Expected: The following token is the text — both spellings must work, people type either.
test('promptFromArgv reads --prompt text', () => {
  expect(promptFromArgv(['/tmp/vClaude', '--prompt', 'Hallo Welt', '--no-sandbox'])).toBe('Hallo Welt')
})

// Setup:    No flag at all, an empty value, a whitespace-only value, and a dangling flag followed by
//           another switch.
// Action:   Extract the prompt.
// Expected: null every time — "parameter not filled" must start the app exactly as without it, and
//           a following switch must never be mistaken for the prompt text.
test('promptFromArgv: nothing usable means no prompt', () => {
  expect(promptFromArgv(['/tmp/vClaude', '--no-sandbox'])).toBeNull()
  expect(promptFromArgv(['/tmp/vClaude', '--prompt='])).toBeNull()
  expect(promptFromArgv(['/tmp/vClaude', '--prompt=   '])).toBeNull()
  expect(promptFromArgv(['/tmp/vClaude', '--prompt', '--no-sandbox'])).toBeNull()
  expect(promptFromArgv([])).toBeNull()
})

// Setup:    The claude.ai template and a prompt containing characters that mean something in a URL.
// Action:   Build the URL.
// Expected: The text lands percent-encoded as ONE query value. It is user input: an unencoded `&`
//           or `#` would let it add parameters or cut the prompt off at a fragment.
test('promptUrl encodes the prompt into the template as a single component', () => {
  expect(promptUrl('https://claude.ai/new?q={prompt}', 'a&b=c #1 ä?'))
    .toBe('https://claude.ai/new?q=a%26b%3Dc%20%231%20%C3%A4%3F')
})

// Setup:    An app without a template, a template lacking the placeholder, and no prompt.
// Action:   Build the URL.
// Expected: null — the caller then falls through to the normal start, so the flag is harmless on
//           an app that cannot take a prompt.
test('promptUrl yields nothing without a usable template or prompt', () => {
  expect(promptUrl(undefined, 'hi')).toBeNull()
  expect(promptUrl('https://example.com/new', 'hi')).toBeNull()
  expect(promptUrl('https://claude.ai/new?q={prompt}', null)).toBeNull()
})

// Setup:    App configs with and without promptTemplate, run through the build's config expander.
// Action:   Read the metadata baked into the AppImage's package.json.
// Expected: The template travels when set. The build bakes an explicit whitelist — a key missing
//           from it is invisible to the runtime no matter what the config says, and the feature
//           would silently do nothing.
test('expandConfig bakes promptTemplate into the AppImage', () => {
  const base = { profile: 'demo', url: 'https://example.com' }
  expect('promptTemplate' in expandConfig(base).extraMetadata).toBe(false)
  expect(expandConfig({ ...base, promptTemplate: 'https://example.com/new?q={prompt}' }).extraMetadata.promptTemplate)
    .toBe('https://example.com/new?q={prompt}')
})

// Setup:    The shipped claude config.
// Action:   Build the prompt URL from its template.
// Expected: A claude.ai new-chat URL carrying the prompt — the config and the code agree on the
//           placeholder spelling.
test('the claude config declares a working prompt template', () => {
  const cfg = require('../webapps/build.claude.json')
  expect(promptUrl(cfg.promptTemplate, 'Hallo')).toBe('https://claude.ai/new?q=Hallo')
})
