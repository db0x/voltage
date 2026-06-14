// Auto-clicks a link (<a>) identified by its aria-label, injected into the page by
// robot.js. Mirrors button.js but targets anchors instead of <button>. This file is a
// TEMPLATE: the {{ariaLabel}} placeholder is filled per-app with the configured matcher
// (JSON-encoded to a string literal) before injection, so it is NOT valid standalone JS.
(function () {
    if (window.__voltageRobotLinkClicked) {
        return;
    }

    // The configured aria-label substring identifying the target link. JSON-encoded by the
    // plugin, so this is a plain string literal here. Empty → nothing to look for, so bail (an
    // empty needle would match every link via includes('')).
    const ARIA_LABEL = {{ariaLabel}};
    if (!ARIA_LABEL) {
        return;
    }
    const needle = ARIA_LABEL.toLowerCase();

    let attempts = 0;

    const timer = setInterval(() => {
        if (++attempts > 60) {
            clearInterval(timer);
            return;
        }

        // Match strictly on the aria-label attribute (case-insensitive, substring) — the link's
        // visible text is intentionally ignored so identification is driven only by aria-label.
        const link = Array.from(document.querySelectorAll('a'))
            .find(a => (a.getAttribute('aria-label') || '').toLowerCase().includes(needle));

        if (!link) {
            return;
        }

        clearInterval(timer);

        window.__voltageRobotLinkClicked = true;
        link.click();
    }, 500);
})();
