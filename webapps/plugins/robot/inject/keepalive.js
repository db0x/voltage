// One burst of "the user is still here" events, run in the app's page by keepalive.js on every
// keep-alive tick. Unlike inject/actions.js this is NOT a template — it carries no configuration
// and no state beyond a tick counter, because the schedule lives in the main process.
//
// Everything is dispatched on `document`: an event dispatched there propagates up to `window` in the
// bubble phase, so a tracker listening on either sees it, and one dispatch does the job of two.
//
// These events are synthetic (isTrusted === false) — a tracker that checks that ignores them, which
// is why keepalive.js ALSO sends a trusted mouse move through Chromium itself. This half is the one
// that still arrives while the window is unfocused or minimised.
(function () {
    var state = window.__voltageRobotKeepAlive || (window.__voltageRobotKeepAlive = { tick: 0 });
    state.tick += 1;

    // Alternating coordinates: a tracker commonly ignores a mousemove reporting the same position as
    // the last one, so a fixed point would read as "no movement" from the second burst onwards.
    var x = 4 + (state.tick % 2);
    var y = 4;
    var mouse = {
        bubbles: true, cancelable: false, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
    };

    // pointermove first: a page written against pointer events may not listen for mouse events at
    // all (they are only emitted as compatibility events for real input, not for a synthetic one).
    if (typeof PointerEvent === 'function') {
        document.dispatchEvent(new PointerEvent('pointermove',
            Object.assign({ pointerType: 'mouse', isPrimary: true }, mouse)));
    }
    document.dispatchEvent(new MouseEvent('mousemove', mouse));

    // Shift, because it is the one key that changes nothing: it never inserts text and is not a
    // shortcut on its own, so a burst landing in a focused text field is harmless. The legacy
    // keyCode/which cannot be forged on a constructed KeyboardEvent (they always read 0) — a
    // tracker still reading those sees only the mouse half, which is why both are sent.
    var key = { bubbles: true, cancelable: true, key: 'Shift', code: 'ShiftLeft' };
    document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ shiftKey: true }, key)));
    document.dispatchEvent(new KeyboardEvent('keyup', key));
})();
