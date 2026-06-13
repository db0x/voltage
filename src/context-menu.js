const { app } = require('electron')
const { spawnSync } = require('node:child_process')

// Spelling-suggestion source for the custom context-menu overlay (the menu itself is rendered
// in-page by the preload — see preload.js / window.js). Falls back to aspell when Electron's
// built-in spellchecker returns no corrections (covers languages the built-in engine doesn't
// support). Tries the system languages first, then English as a last resort.
function aspellSuggestions(word) {
  const preferred = app.getPreferredSystemLanguages().map(l => l.split('-')[0])
  const langs = [...new Set([...preferred, 'en'])]
  for (const lang of langs) {
    const r = spawnSync('aspell', ['-l', lang, '-a'], {
      input: word + '\n',
      encoding: 'utf8',
      timeout: 500,
    })
    if (r.stdout) {
      const match = r.stdout.match(/^& \S+ \d+ \d+: (.+)$/m)
      if (match) return match[1].split(', ').slice(0, 6)
    }
  }
  return []
}

module.exports = { aspellSuggestions }
