// Runs the configured robot actions IN ORDER, injected into the page by robot.js. One action at a
// time: wait for its element to appear, perform it, only then start waiting for the next one. That
// sequencing is the whole point of this file — the earlier design ran one self-contained script per
// action type, and several of those would have raced each other instead of running in order.
//
// This file is a TEMPLATE: the {{actions}} placeholder is filled per-app before injection, so it is
// NOT valid standalone JS.
(function () {
    if (window.__voltageRobotRan) {
        return;
    }
    window.__voltageRobotRan = true;

    // Filled by the plugin as a JSON *string literal*, parsed here rather than pasted as object
    // syntax: config values then can never be read as code, whatever the user typed into the dialog.
    // Shape: [{ target: "button"|"link"|"input"|"focus", identifier: string, value?: string }, …]
    const ACTIONS = JSON.parse({{actions}});
    if (!ACTIONS.length) {
        return;
    }

    const INTERVAL_MS = 500;
    const MAX_ATTEMPTS = 60;  // ≈30 s per action before giving up

    // Targets addressed by exact id rather than by an aria-label substring — for a form field, the
    // id is what markup reliably provides, while its aria-label is often missing or repeated.
    const BY_ID = ['input', 'focus'];

    // button/link match a case-insensitive substring of aria-label — never the visible text, so
    // identification is independent of wording and translation.
    function findElement(action) {
        if (BY_ID.indexOf(action.target) !== -1) {
            return document.getElementById(action.identifier);
        }
        const needle = action.identifier.toLowerCase();
        const selector = action.target === 'link' ? 'a' : 'button';
        return Array.from(document.querySelectorAll(selector))
            .find(el => (el.getAttribute('aria-label') || '').toLowerCase().includes(needle)) || null;
    }

    function performAction(element, action) {
        if (action.target === 'focus') {
            element.focus();
            return;
        }

        if (action.target !== 'input') {
            element.click();
            return;
        }

        // Assign through the prototype's native value setter instead of element.value: a framework
        // that controls this input (React and friends) shadows the property on the element itself,
        // so a plain assignment updates what the user sees but leaves the framework's state stale —
        // it would then overwrite the value again on its next render.
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
        if (setter) {
            setter.call(element, action.value);
        } else {
            element.value = action.value;
        }

        // Emit the events a real keystroke would, so listeners, validation and framework state pick
        // the value up; a silent assignment is invisible to all of them.
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    let index = 0;
    let attempts = 0;

    const timer = setInterval(() => {
        const action = ACTIONS[index];

        // An action whose element never turns up aborts the whole sequence rather than skipping on:
        // the steps are ordered because they build on each other (fill a field, then submit it), so
        // continuing past a missing one would act on a half-prepared page.
        if (++attempts > MAX_ATTEMPTS) {
            clearInterval(timer);
            console.warn('[robot-plugin] gave up waiting for action', index + 1, action);
            return;
        }

        const element = findElement(action);
        if (!element) {
            return;  // not in the DOM yet — the page may still be rendering, so keep waiting
        }

        performAction(element, action);

        index += 1;
        attempts = 0;  // each action gets its own full budget
        if (index >= ACTIONS.length) {
            clearInterval(timer);
        }
    }, INTERVAL_MS);
})();
