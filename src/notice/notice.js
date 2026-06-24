// Renderer for the "app unavailable" notice. Runs without node integration: it only reads the
// pre-localized strings the main process passed via the query string and fills the dialog. The page
// closes its own window (window.close()), which trips main.js's window-all-closed → app.quit().

const params = new URLSearchParams(location.search)

// body.dark drives manager.css's theme tokens (var(--bg) etc.); the <html> flag set in <head> only
// covered the pre-paint background.
if (params.get('dark') === '1') document.body.classList.add('dark')

// Icon of the app that failed to start (file:// URL resolved in the main process), or the bundled
// Voltage logo as a fallback.
document.getElementById('notice-icon').src = params.get('icon') || ''
document.getElementById('notice-title').textContent = params.get('title') || ''
document.getElementById('notice-body').textContent  = params.get('body')  || ''

const ok = document.getElementById('notice-ok')
ok.textContent = params.get('ok') || 'OK'
ok.addEventListener('click', () => window.close())
window.addEventListener('keydown', e => { if (e.key === 'Escape') window.close() })
ok.focus()
