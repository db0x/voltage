// Injected into every app window via executeJavaScript(). Not a Node module.
// Runtime values are declared as consts by buildTooltipScript() in window.js
// and prepended before this script inside a shared IIFE:
//   browserIconUrl, mailIconUrl, safeSrc, unsafeSrc,
//   appOrigin, internalDomains, routeEntries, mailtoLabel

// Bridge so iframe event handlers (which close over this window) can reach IPC.
window._voltageCheck = url => window.electronAPI?.checkSafeBrowsing(url) ?? Promise.resolve('unknown');

// Unwraps redirect URLs (e.g. Outlook Safe Links, Google redirect) to the real target.
function unwrapUrl(url) {
  try {
    const wrapped = new URL(url).searchParams.get('url');
    if (wrapped) { try { new URL(wrapped); return wrapped; } catch {} }
  } catch {}
  return url;
}

// Port of keyMatches() from src/routing-match.js — must stay in sync with it, including the
// '!'-separated negative clauses ("positive!neg1!neg2") used to tell OneNote's extension-less
// Doc.aspx links apart from Word/Excel/PowerPoint. Page-injected JS cannot require the module.
function keyToRegExp(glob) {
  const body = glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp('^' + body + '$');
}
function pathGlobMatches(pat, pathname) {
  return pat.includes('*') ? keyToRegExp(pat).test(pathname) : pathname.startsWith(pat);
}
function keyMatches(key, hostname, pathname) {
  const bang      = key.split('!');
  const positive  = bang[0];
  const negatives = bang.slice(1).filter(Boolean);
  const slash   = positive.indexOf('/');
  const hostPat = slash === -1 ? positive : positive.slice(0, slash);
  const pathPat = slash === -1 ? null : positive.slice(slash);
  const hostOk = hostPat.includes('*')
    ? keyToRegExp(hostPat).test(hostname)
    : (hostname === hostPat || hostname.endsWith('.' + hostPat));
  if (!hostOk) return false;
  if (pathPat !== null && !pathGlobMatches(pathPat, pathname)) return false;
  for (const neg of negatives) if (pathGlobMatches(neg, pathname)) return false;
  return true;
}

// Returns route info { iconDataUrl, name } if this URL would open in another voltage app.
// Unwraps redirect URLs first so Safe Links / Google redirects are matched correctly.
function getRouteInfo(url) {
  try {
    const resolved = unwrapUrl(url);
    // Match against pathname+search so query-only discriminators (e.g. SharePoint
    // Doc.aspx?…file=X.docx) work — must stay in sync with resolveRoute in window.js.
    const u = new URL(resolved);
    return routeEntries.find(e => keyMatches(e.key, u.hostname, u.pathname + u.search)) ?? null;
  } catch { return null; }
}

// Mirrors setWindowOpenHandler — only show tooltip for links that leave the app.
function isExternalLink(url) {
  try {
    const { origin, hostname } = new URL(url);
    if (origin === appOrigin) return false;
    if (internalDomains.some(d => hostname === d || hostname.endsWith('.' + d))) return false;
    return true;
  } catch { return false; }
}

// Tooltip element lives in the main frame — position:fixed is relative to the main viewport.
const tip = document.createElement('div');
tip.id = 'voltage-link-tooltip';
// Icon element is always present; src is swapped per link type (browser vs. mail app).
const iconEl = document.createElement('img');
iconEl.alt = ''; iconEl.style.display = 'none';
tip.appendChild(iconEl);
const shield = document.createElement('img');
shield.id = 'voltage-link-shield'; shield.alt = ''; shield.style.display = 'none';
tip.appendChild(shield);
const label = document.createElement('span');
tip.appendChild(label);
document.body.appendChild(tip);

// Re-attach if an SPA replaces document.body.
function ensureTip() {
  if (document.body && !document.body.contains(tip)) {
    document.body.appendChild(tip);
    bodyObs.observe(document.body, { childList: true });
  }
}
const bodyObs = new MutationObserver(ensureTip);
new MutationObserver(ensureTip).observe(document.documentElement, { childList: true });
bodyObs.observe(document.body, { childList: true });

// Sequence counter discards stale async results when the mouse moves on.
let checkSeq = 0;

function showTooltip(url) {
  const isMail = url.startsWith('mailto:');
  const route  = isMail ? null : getRouteInfo(url);
  const iconSrc = isMail ? mailIconUrl : (route?.iconDataUrl || browserIconUrl);
  if (iconSrc) { iconEl.src = iconSrc; iconEl.style.display = ''; }
  else iconEl.style.display = 'none';
  label.textContent = isMail
    ? mailtoLabel.replace('{addr}', url.slice(7).split('?')[0])
    : unwrapUrl(url);
  shield.style.display = 'none';
  tip.style.display = 'flex';
  // No safe-browsing for mail addresses or links routed to trusted voltage apps.
  if (!isMail && !route) {
    const cs = ++checkSeq;
    window._voltageCheck(url).then(r => {
      if (cs !== checkSeq) return;
      if (r === 'safe'   && safeSrc)   { shield.src = safeSrc;   shield.style.display = ''; }
      if (r === 'unsafe' && unsafeSrc) { shield.src = unsafeSrc; shield.style.display = ''; }
    }).catch(() => {});
  }
}

function hideTooltip() { tip.style.display = 'none'; ++checkSeq; }

// Tracks which documents already have listeners to prevent double-attaching.
const hookedDocs = new WeakSet();

// Attaches hover listeners to a document. All callbacks close over the main-frame scope,
// so showTooltip/hideTooltip always update the tooltip element in the main frame's DOM.
// This means iframes get correct tooltip positioning for free — no CSS injection needed.
function hookDoc(doc) {
  if (hookedDocs.has(doc)) return;
  hookedDocs.add(doc);
  // capture: true fires before any stopPropagation() in the app's own handlers.
  doc.addEventListener('mouseover', e => {
    const url = e.target.closest('a[href]')?.href ?? '';
    if (url && !url.startsWith('javascript:') && (url.startsWith('mailto:') || isExternalLink(url))) showTooltip(url);
    else hideTooltip();
  }, { passive: true, capture: true });
  doc.addEventListener('mouseout', e => {
    if (!e.relatedTarget?.closest('a[href]')) hideTooltip();
  }, { passive: true, capture: true });
}

hookDoc(document);

// Monitor same-origin iframes — hook them so link hovers control the main frame's tooltip.
function watchIframe(iframe) {
  function tryHook() {
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body) hookDoc(doc);
    } catch(e) {}
  }
  iframe.addEventListener('load', tryHook);
  // Immediate check — Strato writes email content via document.write() synchronously
  // after appending the iframe, before the MutationObserver microtask fires.
  tryHook();
}

document.querySelectorAll('iframe').forEach(watchIframe);
// Watch for dynamically added iframes (e.g. single-page apps rendering email lists).
new MutationObserver(rs => {
  for (const r of rs) for (const n of r.addedNodes) {
    if (n.nodeName === 'IFRAME') watchIframe(n);
    else if (n.querySelectorAll) n.querySelectorAll('iframe').forEach(watchIframe);
  }
}).observe(document.documentElement, { childList: true, subtree: true });
