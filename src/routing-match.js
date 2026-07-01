// Shared routing-match logic. This module is the single source of truth for how a
// URL is matched against a routing-table key and how two keys are tested for
// overlap. It is consumed by four places that must never disagree:
//   - src/window.js            (every built AppImage resolves outbound links)
//   - src/plugins/obsidian/main.ts (bundled via esbuild)
//   - scripts/lib.js           (build-time generation of routing.json)
//   - src/manager/ipc/handlers (the create/edit overlap check)
// Keeping it here prevents the matcher in those consumers from drifting apart.
//
// Wildcard semantics: a single '*' is greedy and matches any run of characters,
// including '/'. So "example.com/docs/*" matches "/docs/a/b/c" and "*.example.com"
// matches "a.b.example.com".

'use strict'

// Splits a routing key like "host" or "host/path/prefix" into host and path globs.
// pathPat keeps its leading '/'; it is null for host-only keys.
function splitKey(key) {
  const slash = key.indexOf('/')
  if (slash === -1) return { hostPat: key, pathPat: null }
  return { hostPat: key.slice(0, slash), pathPat: key.slice(slash) }
}

// Converts a glob with greedy '*' into a fully-anchored RegExp. Every regex
// metacharacter is escaped first; the escaped '*' is then turned back into '.*'.
function globToRegExp(glob) {
  const body = glob
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')  // escape all metachars, including '*'
    .replace(/\\\*/g, '.*')                  // our wildcard back to a greedy match
  return new RegExp('^' + body + '$')
}

// A key may carry negative clauses, separated by '!': "positive!neg1!neg2". The key matches
// only if the positive part matches AND no negative path-glob matches. This expresses claims
// a plain glob cannot — notably "Doc.aspx but NOT *.docx/*.xlsx/*.pptx", which is how OneNote
// notebooks are told apart from Word/Excel/PowerPoint (all open via the same generic Doc.aspx,
// and OneNote's link carries no file extension at all). Negatives are path globs tested
// against the pathname(+search), same matcher as the positive path.
function splitNegations(key) {
  const i = key.indexOf('!')
  if (i === -1) return { positive: key, negatives: [] }
  const parts = key.split('!')
  return { positive: parts[0], negatives: parts.slice(1).filter(Boolean) }
}

// Path-glob match: wildcard globs are full-match (greedy '*'); a literal keeps startsWith.
function pathGlobMatches(pat, pathname) {
  return pat.includes('*') ? globToRegExp(pat).test(pathname) : pathname.startsWith(pat)
}

// Tests whether a routing key matches a given host/pathname pair. `hostname` here is the URL's
// host INCLUDING any non-default :port (callers pass u.host, not u.hostname) so keys built with a
// port only match the same port — local Docker apps share "localhost" and differ only by port.
// Non-wildcard hosts keep the legacy "exact host or any subdomain" rule and
// non-wildcard paths keep the legacy startsWith (prefix) rule, so existing
// tables built before wildcard support behave identically.
function keyMatches(key, hostname, pathname) {
  const { positive, negatives } = splitNegations(key)
  const { hostPat, pathPat } = splitKey(positive)

  const hostOk = hostPat.includes('*')
    ? globToRegExp(hostPat).test(hostname)
    : (hostname === hostPat || hostname.endsWith('.' + hostPat))
  if (!hostOk) return false

  if (pathPat !== null && !pathGlobMatches(pathPat, pathname)) return false

  // Any negative clause that matches the path disqualifies the whole key.
  for (const neg of negatives) if (pathGlobMatches(neg, pathname)) return false
  return true
}

// Tests whether two greedy-'*' globs can match a common string. Implemented as an
// NFA-intersection over both patterns: state (i, j) asks whether the suffixes
// a[i:] and b[j:] can generate one shared string. A '*' may absorb zero or more
// characters of that shared string independently on each side.
function globsIntersect(a, b) {
  const memo = new Map()
  function go(i, j) {
    if (i === a.length && j === b.length) return true
    const memoKey = i * (b.length + 1) + j
    const cached = memo.get(memoKey)
    if (cached !== undefined) return cached

    const aStar = i < a.length && a[i] === '*'
    const bStar = j < b.length && b[j] === '*'
    let res
    if (aStar && bStar) {
      res = go(i + 1, j) || go(i, j + 1)
    } else if (aStar) {
      res = go(i + 1, j) || (j < b.length && go(i, j + 1))
    } else if (bStar) {
      res = go(i, j + 1) || (i < a.length && go(i + 1, j))
    } else if (i < a.length && j < b.length && a[i] === b[j]) {
      res = go(i + 1, j + 1)
    } else {
      res = false
    }
    memo.set(memoKey, res)
    return res
  }
  return go(0, 0)
}

// Expands a host pattern into the glob forms it effectively claims. A literal host
// also routes its subdomains (legacy keyMatches semantics), so it expands to both
// "host" and "*.host"; a host already containing '*' is taken verbatim.
function hostForms(hostPat) {
  return hostPat.includes('*') ? [hostPat] : [hostPat, '*.' + hostPat]
}

// Normalises a key's path part into a glob matching the same set keyMatches does:
//   host-only (null) -> '*'   (every path)
//   literal '/p'     -> '/p*' (prefix, mirrors startsWith)
//   wildcard path    -> as-is (full-match glob)
function pathGlob(pathPat) {
  if (pathPat === null) return '*'
  return pathPat.includes('*') ? pathPat : pathPat + '*'
}

// Tests whether two routing keys could ever match the same URL. Used to block
// configuring a routing-URL that overlaps another app's claim. Conservative:
// host parts overlap if any of their expanded forms intersect. Negative clauses are
// ignored here — they only narrow a claim, so comparing the positive parts stays a safe
// (over-approximating) overlap test.
function keyOverlaps(keyA, keyB) {
  const a = splitKey(splitNegations(keyA).positive)
  const b = splitKey(splitNegations(keyB).positive)
  const hostOk = hostForms(a.hostPat).some(fa =>
    hostForms(b.hostPat).some(fb => globsIntersect(fa, fb)))
  if (!hostOk) return false
  return globsIntersect(pathGlob(a.pathPat), pathGlob(b.pathPat))
}

// Normalises a routing.json payload into separate { base, routing } maps. base keys
// come from each app's primary URL, routing keys from its routingUrls. The two are kept
// apart because the same key string may legitimately appear as one app's base claim and
// another app's routing claim. The legacy flat shape (a plain key→entry map) is read as
// an all-base table so tables written before the split keep working.
function normalizeRouting(raw) {
  if (raw && (raw.base || raw.routing)) {
    return { base: raw.base ?? {}, routing: raw.routing ?? {} }
  }
  return { base: raw ?? {}, routing: {} }
}

// Resolves a URL against a routing payload. A routing-URL claim always wins over a
// base-URL claim it overlaps (per the routing rules); within a single kind the longest
// matching key wins for specificity. `accept(entry)` lets the caller skip ineligible
// targets (e.g. the current app itself, or a not-yet-built AppImage) so resolution falls
// through to the next candidate instead of giving up. Returns { key, entry, kind } | null.
function findRoute(raw, hostname, pathname, accept = () => true) {
  const routing = normalizeRouting(raw)
  for (const kind of ['routing', 'base']) {
    const match = Object.entries(routing[kind])
      .sort((a, b) => b[0].length - a[0].length)
      .find(([key, entry]) => keyMatches(key, hostname, pathname) && accept(entry))
    if (match) return { key: match[0], entry: match[1], kind }
  }
  return null
}

// Converts a user-entered URL/pattern (e.g. "https://docs.example.com/d/*") into a
// routing-table key ("docs.example.com/d/*"). new URL() rejects '*' in the host,
// so the host/path split is done by hand. Returns null when no host is present.
// The query string is preserved (matching runs against pathname+search) so keys can
// discriminate by query — e.g. SharePoint's "*Doc.aspx*.docx*". Only the '#' fragment is
// dropped (never routing-relevant), and a trailing slash is trimmed from the path part
// only, not from inside a query.
function urlToRoutingKey(input) {
  if (!input) return null
  let s = String(input).trim()
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')  // strip scheme://
  s = s.replace(/^\/+/, '')                           // drop stray leading slashes
  if (!s) return null
  const slash = s.indexOf('/')
  // Keep any :port — with local Docker apps several profiles share the host "localhost" and are told
  // apart only by port, so stripping it made them all collide (localhost:5001 vs localhost:8888).
  let host     = (slash === -1 ? s : s.slice(0, slash)).toLowerCase()
  let rest     = (slash === -1 ? '' : s.slice(slash)).split('#')[0]  // keep '?query', drop '#frag'
  const qIdx   = rest.indexOf('?')
  // Trim a trailing slash from the path portion only (before any '?'), leaving the query intact.
  let pathPart = qIdx === -1
    ? rest.replace(/\/+$/, '')
    : rest.slice(0, qIdx).replace(/\/+$/, '') + rest.slice(qIdx)
  if (!host) return null
  return pathPart ? host + pathPart : host
}

// Derives the primary routing key from a config's main URL. Primary URLs are real,
// wildcard-free URLs, so the legacy host + first-path-segment derivation is kept. Uses u.host (not
// u.hostname) so a non-default :port is part of the key — required for local Docker apps that share
// "localhost" and differ only by port. u.host normalises default ports away, so real domains without
// an explicit port produce the same key as before (existing routing tables unchanged).
function primaryKeyFromUrl(url) {
  try {
    const u = new URL(url)
    const first = u.pathname.replace(/^\//, '').split('/')[0]
    return first ? `${u.host}/${first}` : u.host
  } catch {
    return null
  }
}

// Returns every routing-table key a config claims: the primary URL plus all
// routingUrls. Mirrors exactly what updateRoutingTable() writes, so the overlap
// check sees the same keys that will end up in routing.json.
function routingKeysForConfig(cfg) {
  const keys = []
  const primary = primaryKeyFromUrl(cfg.url)
  if (primary) keys.push(primary)
  for (const extra of cfg.routingUrls ?? []) {
    const k = urlToRoutingKey(extra)
    if (k) keys.push(k)
  }
  return keys
}

// Returns the routing keys a config's routingUrls claim (empty when it has none).
function routingUrlKeys(cfg) {
  const keys = []
  for (const extra of cfg.routingUrls ?? []) {
    const k = urlToRoutingKey(extra)
    if (k) keys.push(k)
  }
  return keys
}

module.exports = {
  keyMatches,
  keyOverlaps,
  globToRegExp,
  globsIntersect,
  urlToRoutingKey,
  primaryKeyFromUrl,
  routingKeysForConfig,
  routingUrlKeys,
  normalizeRouting,
  findRoute,
}