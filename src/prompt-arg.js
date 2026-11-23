// Launching an app WITH a prompt: `vClaude --prompt="Explain monads"` opens the app straight on a
// new chat carrying that text. Which URL does that is the app's business, not ours — claude.ai,
// ChatGPT and friends each have their own "prefilled new chat" address — so the app config names it
// as `promptTemplate` with a `{prompt}` placeholder, the same idea as mailtoTemplate for mailto:.
//
// Pure (no Electron) so both halves are unit-testable; src/app-window.js does the wiring.

const FLAG = '--prompt'

// The prompt text from a process argv, or null. Accepts `--prompt=text` and `--prompt text`. A named
// flag rather than a bare positional argument on purpose: the launcher already passes a positional
// (%u — a URL or file), and free text there would be indistinguishable from a mistyped path.
// Empty or whitespace-only means "no prompt": the app then starts exactly as it does without the flag.
function promptFromArgv(argv = []) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    let text = null
    if (a.startsWith(`${FLAG}=`)) text = a.slice(FLAG.length + 1)
    // The two-token form only takes the next token when it is not another switch, so a dangling
    // `--prompt --no-sandbox` reads as an empty prompt instead of prompting "--no-sandbox".
    else if (a === FLAG && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--')) text = argv[i + 1]
    else continue
    return text.trim() ? text : null
  }
  return null
}

// The URL to open for a prompt, or null when the app declares no template (the flag is then simply
// ignored — an app that cannot take a prompt must still start normally). The text is percent-encoded
// as ONE component: it is user input and must not be able to add parameters or a fragment of its own.
function promptUrl(template, prompt) {
  if (typeof template !== 'string' || !template.includes('{prompt}') || !prompt) return null
  return template.replace('{prompt}', encodeURIComponent(prompt))
}

module.exports = { promptFromArgv, promptUrl }
