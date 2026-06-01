// Shared mailto helpers, used by app-window.js and by main-process plugins (e.g. the
// strato-mail plugin) that need to drive a web app's compose UI from a mailto: launch.
// Kept separate so plugins can require it without depending on app-window internals.

// Parses a mailto: URI (e.g. "mailto:a@b.com?subject=Hi") into a plain object.
// URL() handles the parsing; the recipient is in the URL pathname, not a query param.
function parseMailtoFields(raw) {
  try {
    const m = new URL(raw)
    return {
      to:      decodeURIComponent(m.pathname || ''),
      subject: m.searchParams.get('subject') || '',
      body:    m.searchParams.get('body')    || '',
      cc:      m.searchParams.get('cc')      || '',
      bcc:     m.searchParams.get('bcc')     || '',
    }
  } catch { return null }
}

// Polls until the compose-to input field is focused (detected by CSS class "tt-input"),
// then simulates keyboard input to fill in the recipient and subject.
// Native sendInputEvent is used because executeJavaScript cannot trigger
// the web app's own keydown handlers reliably for token-input widgets.
function typeMailtoFields(win, fields) {
  if (!fields || (!fields.to && !fields.subject)) return
  let attempts = 0
  function poll() {
    if (++attempts > 40 || win.isDestroyed()) return
    win.webContents.executeJavaScript('document.activeElement.className')
      .then(async cls => {
        if (typeof cls === 'string' && cls.includes('tt-input')) {
          if (fields.to) {
            for (const char of fields.to)
              win.webContents.sendInputEvent({ type: 'char', keyCode: char })
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
            win.webContents.sendInputEvent({ type: 'keyUp',   keyCode: 'Return' })
            await new Promise(r => setTimeout(r, 300))
          }
          if (fields.subject) {
            const ok = await win.webContents.executeJavaScript(
              `var s=document.querySelector('input[name="subject"]');s?(s.focus(),true):false`
            )
            if (ok) {
              await new Promise(r => setTimeout(r, 100))
              for (const char of fields.subject)
                win.webContents.sendInputEvent({ type: 'char', keyCode: char })
            }
          }
        } else {
          setTimeout(poll, 300)
        }
      })
      .catch(() => setTimeout(poll, 300))
  }
  setTimeout(poll, 300)
}

module.exports = { parseMailtoFields, typeMailtoFields }
