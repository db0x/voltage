// Keep-alive (part of the robot plugin, main-process side). Feeds a small burst of user-activity
// events into the app's page every few minutes, so an app that watches its own window for activity
// keeps treating the session as active.
//
// The case this exists for: Teams flips its presence to "Away" when nothing happens *inside its
// window* — sitting at the machine and working in another window is indistinguishable, to Teams,
// from having left. The plugin already automates interactions on load; this keeps them relevant by
// keeping the session it logged into alive.
//
// Two channels are used per tick, because each one fails in a case the other survives:
//   1. webContents.sendInputEvent — a REAL Chromium input event (isTrusted), so a page that filters
//      synthetic events still counts it. But keyboard input goes to the focused widget, and the
//      window is by definition NOT focused in the scenario this feature is for, so only the mouse
//      move is sent this way.
//   2. inject/keepalive.js — events the page dispatches on itself. Always delivered, focused or
//      not, minimised or not, but isTrusted is false, so a tracker that checks it ignores them.
// Whichever the app's activity tracker listens to, at least one of the two reaches it.

const { screen } = require('electron')
const fs   = require('node:fs')
const path = require('node:path')

const TAG = '[robot-plugin]'

// Interval bounds. 5 minutes is the default because the presence timeouts this works around sit
// around that mark; the range in config.html must stay in sync with these.
const DEFAULT_MINUTES = 5
const MIN_MINUTES = 1
const MAX_MINUTES = 30

// The page-side burst, read once. Not a template (unlike inject/actions.js) — it carries no config,
// since the interval is owned by the timer here and the burst itself is always the same.
const NUDGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'inject', 'keepalive.js'), 'utf8')

// Where the synthetic pointer is parked when the real cursor is somewhere else entirely: a few
// pixels into the content, which is window chrome or an inert edge in every app rather than a
// control that would react to being hovered.
const PARKED_X = 4
const PARKED_Y = 4

// The keep-alive settings for an app: whether it runs at all and how often. Off unless explicitly
// enabled — synthetic input is not something every app that uses robot's load actions should get.
// Accepts the string forms too, so a hand-written build.*.json config behaves like the dialog's.
function resolveKeepAlive(config) {
    const enabled = config?.keepAlive === true || config?.keepAlive === 'true';
    const raw = Number(config?.keepAliveMinutes);
    const minutes = Number.isFinite(raw)
        ? Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(raw)))
        : DEFAULT_MINUTES;
    return { enabled, minutes, intervalMs: minutes * 60 * 1000 };
}

// Content-relative point for the synthetic mouse move. A trusted move really does move the page's
// pointer, so when the real cursor sits inside this window we aim at where it already is: hover
// state and any open tooltip then survive the nudge. Only when the cursor is elsewhere does the
// pointer get parked in the corner.
//
// `tick` shifts the point by one pixel on alternating ticks: an activity tracker commonly ignores a
// mousemove that reports the SAME position as the last one, so two identical bursts would read as
// no movement at all.
function nudgePoint(win, tick) {
    const jiggle = tick % 2;
    try {
        const bounds = win.getContentBounds();
        const cursor = screen.getCursorScreenPoint();
        const x = cursor.x - bounds.x;
        const y = cursor.y - bounds.y;
        if (x >= 0 && y >= 0 && x < bounds.width && y < bounds.height) {
            return { x: Math.max(0, x - jiggle), y };
        }
    } catch {
        // Window already gone, or no cursor to read (headless) — fall through to the parked point.
    }
    return { x: PARKED_X + jiggle, y: PARKED_Y };
}

// One tick: the trusted mouse move, then the page-dispatched burst. Both are best-effort — a load
// in flight or a window closing mid-tick must not turn into an unhandled rejection.
function nudge(win, wc, tick) {
    if (wc.isDestroyed()) return;
    const { x, y } = nudgePoint(win, tick);
    try {
        wc.sendInputEvent({ type: 'mouseMove', x, y });
    } catch {}
    wc.executeJavaScript(NUDGE_SCRIPT).catch(() => {});
}

// Starts the keep-alive timer if the app enabled it; returns a stop function (a no-op when off).
// The timer lives in the main process on purpose: it must survive page loads and keep firing while
// the window is unfocused or minimised, where a renderer timer would be throttled to a crawl.
function startKeepAlive(win, api) {
    const { enabled, minutes, intervalMs } = resolveKeepAlive(api.config);
    if (!enabled) return () => {};

    const wc = api.webContents;
    let tick = 0;
    const timer = setInterval(() => nudge(win, wc, ++tick), intervalMs);
    const stop = () => clearInterval(timer);
    win.once('closed', stop);

    console.log(TAG, `keep-alive: every ${minutes} min`);
    return stop;
}

// resolveKeepAlive is exported for the unit tests (tests/robot-keepalive.spec.js) — it is the whole
// decision layer (is it on, how often), testable without an Electron window.
module.exports = { startKeepAlive, resolveKeepAlive, DEFAULT_MINUTES, MIN_MINUTES, MAX_MINUTES };
