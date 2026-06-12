// Strato webmail (Open-Xchange) mail plugin (main-process module).
//
// Strato has no mailto: URL scheme to load — compose is opened by clicking the app's own
// "Neue E-Mail" button, then the recipient/subject are typed into its token-input widgets.
// So this is a main-process plugin (not a page-injected script): it only acts when the app
// is LAUNCHED with a mailto: argument, and stays completely inert on a normal start. That
// launch-gating is the whole reason it can't be a plain always-injected renderer script.

const TAG = '[strato-mail-plugin]'

// Clicks the "Neue E-Mail" compose button. Injected into the page because it must trigger the
// web app's own click handler; polled because the toolbar renders asynchronously after load.
const CLICK_COMPOSE = `(function () {
  var n = 0;
  var t = setInterval(function () {
    if (++n > 60) { clearInterval(t); return; }
    var btn = Array.from(document.querySelectorAll('button.btn.btn-primary'))
      .find(function (b) { return b.textContent.includes('Neue E-Mail'); });
    if (!btn) return;
    clearInterval(t);
    btn.click();
  }, 400);
})();`

// webContents is the APP's webContents (api.webContents), NOT win.webContents: if the app also
// loads the widget plugin it runs in an inset view, where win.webContents is the empty host page —
// injecting/typing there would silently do nothing.
function attachPlugin(win, { webContents, launchArg, mailto }) {
  // Opens compose and fills in the mailto: fields. The button-click only fires for a mailto:
  // launch, so a normal app start never pops a compose window.
  const compose = (arg) => {
    if (!arg || !arg.startsWith('mailto:')) return
    const fields = mailto.parseMailtoFields(arg)
    webContents.executeJavaScript(CLICK_COMPOSE).catch(() => {})
    mailto.typeMailtoFields(webContents, fields)
  }

  // Initial launch: wait for the first load before clicking the (not-yet-rendered) button.
  if (launchArg && launchArg.startsWith('mailto:')) {
    webContents.once('did-finish-load', () => compose(launchArg))
  }

  console.log(TAG, 'attached to Strato Mail window')

  // Second-instance launch with a new mailto: — the page is already loaded, so compose now.
  return { onLaunch: (arg) => compose(arg) }
}

module.exports = { attachPlugin }
