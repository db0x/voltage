const { test, expect } = require('@playwright/test')
const {
  keyMatches,
  keyOverlaps,
  urlToRoutingKey,
  primaryKeyFromUrl,
  routingKeysForConfig,
  globsIntersect,
  normalizeRouting,
  findRoute,
} = require('../src/routing-match')

// Pure-logic unit tests for the shared routing matcher. No Electron/browser needed —
// these run in the plain Playwright node runner and guard the four consumers that
// depend on this module behaving identically.

test.describe('keyMatches — legacy (non-wildcard) behaviour', () => {
  // Setup:    a host-only key, mirroring how primary URLs are stored today.
  // Action:   match the host itself and a subdomain of it.
  // Expected: both match, because a literal host also claims its subdomains.
  test('host-only key matches host and subdomains', () => {
    expect(keyMatches('example.com', 'example.com', '/')).toBe(true)
    expect(keyMatches('example.com', 'app.example.com', '/x')).toBe(true)
    expect(keyMatches('example.com', 'notexample.com', '/')).toBe(false)
  })

  // Setup:    a host/path key like the existing google-spreadsheets routingUrl.
  // Action:   match paths under and outside the prefix.
  // Expected: literal paths keep startsWith (prefix) semantics.
  test('host/path key uses path prefix', () => {
    expect(keyMatches('docs.google.com/spreadsheets', 'docs.google.com', '/spreadsheets/d/1')).toBe(true)
    expect(keyMatches('docs.google.com/spreadsheets', 'docs.google.com', '/document/d/1')).toBe(false)
  })
})

test.describe('keyMatches — wildcards', () => {
  // Setup:    a greedy path wildcard.
  // Action:   match a deep nested path.
  // Expected: '*' spans '/' so nested paths match.
  test('greedy path wildcard spans slashes', () => {
    expect(keyMatches('example.com/docs/*', 'example.com', '/docs/a/b/c')).toBe(true)
    expect(keyMatches('example.com/docs/*', 'example.com', '/other')).toBe(false)
  })

  // Setup:    a subdomain host wildcard.
  // Action:   match single- and multi-label subdomains.
  // Expected: '*.example.com' matches any subdomain depth but not the bare apex.
  test('host wildcard matches subdomains', () => {
    expect(keyMatches('*.example.com', 'foo.example.com', '/')).toBe(true)
    expect(keyMatches('*.example.com', 'a.b.example.com', '/')).toBe(true)
    expect(keyMatches('*.example.com', 'example.com', '/')).toBe(false)
  })
})

test.describe('urlToRoutingKey', () => {
  // Setup:    assorted user inputs with schemes, ports, query, hash, trailing slash.
  // Action:   normalise each into a routing key.
  // Expected: scheme/port/hash/trailing-slash stripped, host lowercased, path kept — and the
  //           query is PRESERVED (matching runs against pathname+search, so keys may use it).
  test('normalises inputs, keeps path, and preserves the query', () => {
    expect(urlToRoutingKey('https://docs.example.com/d/123')).toBe('docs.example.com/d/123')
    // Port + scheme stripped, host lowercased, trailing slash trimmed from the path, '#x'
    // dropped, but '?a=1' kept.
    expect(urlToRoutingKey('https://Example.COM:8443/Foo/?a=1#x')).toBe('example.com/Foo?a=1')
    expect(urlToRoutingKey('example.com/')).toBe('example.com')
    expect(urlToRoutingKey('*.example.com/docs/*')).toBe('*.example.com/docs/*')
    // SharePoint-style key: '.docx' lives past a '?'; the query must survive normalisation.
    expect(urlToRoutingKey('https://*.sharepoint.com/Doc.aspx?file=*.docx*'))
      .toBe('*.sharepoint.com/Doc.aspx?file=*.docx*')
    expect(urlToRoutingKey('   ')).toBe(null)
  })
})

test.describe('keyMatches — query-aware (Office document routing)', () => {
  // The matcher receives pathname+search so SharePoint's generic Doc.aspx links — which only
  // differ by the .docx/.xlsx/.pptx filename in the query — can route to the right app.
  const host = 'contoso-my.sharepoint.com'
  const docAspx = (ext) => `/personal/u/_layouts/15/Doc.aspx?sourcedoc=%7Bx%7D&file=Report.${ext}&action=default`

  // Setup:    a Doc.aspx link whose query carries a .docx filename.
  // Action:   match it against each Office app's filename key.
  // Expected: only the *.docx* key matches — the .xlsx/.pptx keys do not, so a Word document
  //           never leaks into Excel or PowerPoint.
  test('filename-in-query routes to exactly one app', () => {
    expect(keyMatches('*.sharepoint.com/*.docx*', host, docAspx('docx'))).toBe(true)
    expect(keyMatches('*.sharepoint.com/*.xlsx*', host, docAspx('docx'))).toBe(false)
    expect(keyMatches('*.sharepoint.com/*.pptx*', host, docAspx('docx'))).toBe(false)

    expect(keyMatches('*.sharepoint.com/*.xlsx*', host, docAspx('xlsx'))).toBe(true)
    expect(keyMatches('*.sharepoint.com/*.docx*', host, docAspx('xlsx'))).toBe(false)

    expect(keyMatches('*.sharepoint.com/*.pptx*', host, docAspx('pptx'))).toBe(true)
    expect(keyMatches('*.sharepoint.com/*.docx*', host, docAspx('pptx'))).toBe(false)
  })

  // Setup:    a share-style link using the office scheme token (:w:/:x:/:p:) in the path.
  // Action:   match against the scheme-token key.
  // Expected: the token in the path is enough — these links carry no filename.
  test('scheme-token share links match on the path', () => {
    expect(keyMatches('*.sharepoint.com/:w:/*', host, '/:w:/r/personal/u/Doc.aspx?e=1')).toBe(true)
    expect(keyMatches('*.sharepoint.com/:x:/*', host, '/:x:/r/personal/u/Doc.aspx?e=1')).toBe(true)
    expect(keyMatches('*.sharepoint.com/:p:/*', host, '/:p:/r/personal/u/Doc.aspx?e=1')).toBe(true)
    expect(keyMatches('*.sharepoint.com/:w:/*', host, '/:x:/r/personal/u/Doc.aspx?e=1')).toBe(false)
  })
})

test.describe('keyMatches — negative clauses (OneNote routing)', () => {
  // OneNote notebooks open via the SAME generic Doc.aspx as Word/Excel/PowerPoint but their
  // link carries no file extension (the "file=" value is the notebook name, a folder). A glob
  // cannot express "Doc.aspx but NOT *.docx", so a key may append '!'-separated negatives:
  // it matches only if the positive matches AND no negative does.
  const host    = 'contoso.sharepoint.com'
  // The real-world shapes observed: Word carries file=….docx; OneNote carries an extension-less name.
  const wordUrl = '/sites/X/_layouts/15/Doc.aspx?sourcedoc=%7B1%7D&file=Report.docx&action=default'
  const noteUrl = '/sites/X/_layouts/15/Doc.aspx?sourcedoc=%7B2%7D&file=Project%20Documentation&action=edit&wdorigin=Sharepoint'
  // A Word doc opened via the :w:/ viewer carries NO extension in the URL — only a GUID sourcedoc —
  // so the *.docx negation can't catch it; the key must also exclude the office scheme tokens.
  const wordViewerUrl = '/:w:/r/personal/u/_layouts/15/Doc.aspx?sourcedoc=%7B3%7D&action=default'
  const KEY     = '*.sharepoint.com/*Doc.aspx*!*.docx*!*.xlsx*!*.pptx*!*/:w:/*!*/:x:/*!*/:p:/*'

  // Setup:    the OneNote key (Doc.aspx minus the three Office extensions).
  // Action:   match an extension-less Doc.aspx link and an Office one.
  // Expected: the extension-less (OneNote) link matches; the .docx (Word) link is excluded
  //           by a negative clause — so OneNote never steals a Word/Excel/PowerPoint document.
  test('Doc.aspx without an office extension matches; with one it is excluded', () => {
    expect(keyMatches(KEY, host, noteUrl)).toBe(true)
    expect(keyMatches(KEY, host, wordUrl)).toBe(false)
    // A standalone Word key still claims the .docx link.
    expect(keyMatches('*.sharepoint.com/*.docx*', host, wordUrl)).toBe(true)
    expect(keyMatches('*.sharepoint.com/*.docx*', host, noteUrl)).toBe(false)
  })

  // Setup:    full table with both OneNote (negated) and Word keys as routing entries.
  // Action:   resolve a Word URL and a OneNote URL.
  // Expected: each resolves to its own app — the longest-key-first order tries the (longer)
  //           OneNote key first, whose negation lets the .docx fall through to Word.
  test('findRoute separates OneNote from Word on shared Doc.aspx', () => {
    const table = { base: {}, routing: {
      '*.sharepoint.com/*.docx*': { path: '/d/wrapweb-word',    name: 'Word' },
      [KEY]:                      { path: '/d/wrapweb-onenote', name: 'OneNote' },
    } }
    expect(findRoute(table, host, wordUrl)?.entry.name).toBe('Word')
    expect(findRoute(table, host, noteUrl)?.entry.name).toBe('OneNote')
  })

  // Setup:    a Word doc opened via the :w:/ viewer — GUID sourcedoc, no extension in the URL — in a
  //           table where the OneNote key is LONGER than Word's (so it is tried first). This is the
  //           bug: without the scheme-token negatives, OneNote's *Doc.aspx* swallowed such links and,
  //           since appClaimsUrl picks the global longest-key winner, kept them in OneNote.
  // Action:   match the OneNote key directly and resolve the URL across both apps.
  // Expected: the OneNote key excludes it (scheme-token negative) and it resolves to Word.
  test('a :w:/ viewer Word link (no extension) is excluded from OneNote and routes to Word', () => {
    expect(keyMatches(KEY, host, wordViewerUrl)).toBe(false)
    expect(keyMatches('*.sharepoint.com/:w:/*', host, wordViewerUrl)).toBe(true)
    const table = { base: {}, routing: {
      '*.sharepoint.com/:w:/*': { path: '/d/wrapweb-word',    name: 'Word' },
      [KEY]:                    { path: '/d/wrapweb-onenote', name: 'OneNote' },
    } }
    expect(findRoute(table, host, wordViewerUrl)?.entry.name).toBe('Word')
  })

  // Setup:    OneNote opens one of its own notes from inside the OneNote app — the table only
  //           has the OneNote key, and resolveRoute's eligibility predicate excludes the current
  //           app (so docs route to OTHER apps). This is the exact shape that sent a clicked note
  //           to the browser: routeUrl found no eligible target.
  // Action:   resolve the note URL twice — once with self EXCLUDED (routeUrl's predicate), once
  //           with self ALLOWED (appClaimsUrl's predicate).
  // Expected: excluded → no route (the old browser fall-through); allowed → OneNote claims it.
  //           The two predicates are exact inverses, so loading in-app is correct precisely when
  //           routeUrl misses by self-exclusion.
  test('a self-owned note: excluded by routeUrl, claimed by appClaimsUrl', () => {
    const table = { base: {}, routing: { [KEY]: { path: '/d/wrapweb-onenote', name: 'OneNote' } } }
    const isOnenote = (e) => e.path.replace(/.*\/wrapweb-/, '') === 'onenote'
    expect(findRoute(table, host, noteUrl, (e) => !isOnenote(e))).toBe(null)
    expect(findRoute(table, host, noteUrl, isOnenote)?.entry.name).toBe('OneNote')
  })

  // Setup:    a personal-OneDrive note lives under the "-my" SharePoint host — which is OneDrive's
  //           OWN base key (its primary URL host) — while OneNote claims it via a Doc.aspx ROUTING
  //           key. Both apps' claims match the URL: a base claim (OneDrive) and a routing claim
  //           (OneNote). This is the exact conflict that opened a note inside OneDrive.
  // Action:   resolve the rightful owner the way appClaimsUrl does — across ALL built apps, no
  //           self-exclusion (eligibility = the AppImage exists, here always true).
  // Expected: OneNote wins, because findRoute checks routing claims before base claims. So the
  //           note belongs to OneNote from EITHER app: OneNote self-claims (load in place),
  //           OneDrive does not (routes it away to OneNote) — both correct.
  test('a personal (-my) note: routing claim (OneNote) beats base claim (OneDrive host)', () => {
    const myHost  = 'contoso-my.sharepoint.com'
    const myNote  = '/personal/user_contoso_de/_layouts/15/Doc.aspx?sourcedoc=%7B7%7D&file=Mein%20Notizbuch&action=edit&mobileredirect=true'
    const ownerOf = (e) => e.path.replace(/.*\/wrapweb-/, '')
    const table = { base:    { [myHost]: { path: '/d/wrapweb-onedrive', name: 'OneDrive' } },
                    routing: { [KEY]:    { path: '/d/wrapweb-onenote',  name: 'OneNote' } } }
    expect(keyMatches(KEY, myHost, myNote)).toBe(true)            // OneNote's routing key matches
    expect(keyMatches(myHost, myHost, myNote)).toBe(true)         // OneDrive's base key matches too
    // appClaimsUrl's resolution: eligibility = exists (no self-exclusion) → the global winner.
    expect(ownerOf(findRoute(table, myHost, myNote, () => true).entry)).toBe('onenote')
  })
})

test.describe('routingKeysForConfig', () => {
  // Setup:    a config with a primary URL and two routingUrls.
  // Action:   derive its full claim set.
  // Expected: primary uses host+first-segment; routingUrls keep full paths/wildcards.
  test('collects primary + routingUrls', () => {
    const cfg = {
      url: 'https://docs.google.com',
      routingUrls: ['https://docs.google.com/spreadsheets', 'https://sheets.google.com/*'],
    }
    expect(routingKeysForConfig(cfg)).toEqual([
      'docs.google.com',
      'docs.google.com/spreadsheets',
      'sheets.google.com/*',
    ])
  })

  test('primaryKeyFromUrl keeps only the first path segment', () => {
    expect(primaryKeyFromUrl('https://docs.google.com/a/b')).toBe('docs.google.com/a')
    expect(primaryKeyFromUrl('https://docs.google.com')).toBe('docs.google.com')
  })
})

test.describe('keyOverlaps', () => {
  // Setup:    pairs of keys that should and should not collide.
  // Action:   test overlap in both directions.
  // Expected: overlap is symmetric and catches host-subdomain + path-prefix + wildcard cases.
  test('detects colliding claims', () => {
    // Identical hosts.
    expect(keyOverlaps('example.com', 'example.com')).toBe(true)
    // A host claim swallows its subdomains.
    expect(keyOverlaps('example.com', 'app.example.com')).toBe(true)
    expect(keyOverlaps('app.example.com', 'example.com')).toBe(true)
    // Wildcard host vs concrete subdomain.
    expect(keyOverlaps('*.example.com', 'foo.example.com')).toBe(true)
    // Overlapping path prefixes on the same host.
    expect(keyOverlaps('docs.example.com/d', 'docs.example.com/d/*')).toBe(true)
    // Path wildcard intersecting a prefix.
    expect(keyOverlaps('host.com/a/*', 'host.com/a/b')).toBe(true)
  })

  test('allows disjoint claims', () => {
    // Different hosts entirely.
    expect(keyOverlaps('example.com', 'example.org')).toBe(false)
    // Same host, non-overlapping path segments.
    expect(keyOverlaps('docs.google.com/spreadsheets', 'docs.google.com/document')).toBe(false)
    // Sibling subdomains under a wildcard do not collide with a different concrete host.
    expect(keyOverlaps('a.example.com', 'b.example.com')).toBe(false)
  })
})

test.describe('normalizeRouting', () => {
  // Setup:    a structured table and a legacy flat table.
  // Action:   normalise both.
  // Expected: structured passes through; legacy flat is read as an all-base table.
  test('handles structured and legacy shapes', () => {
    const structured = { base: { 'a.com': { path: '/a' } }, routing: { 'b.com': { path: '/b' } } }
    expect(normalizeRouting(structured)).toEqual(structured)

    const flat = { 'a.com': { path: '/a' } }
    expect(normalizeRouting(flat)).toEqual({ base: flat, routing: {} })
  })
})

test.describe('findRoute', () => {
  const table = {
    base:    { 'example.com': { path: '/AppA' } },
    routing: { 'example.com': { path: '/AppB' } },
  }

  // Setup:    a base claim and a routing claim on the same host, pointing at different apps.
  // Action:   resolve a URL matching both.
  // Expected: the routing claim wins (AppB) — routing-URLs take priority over base-URLs.
  test('routing claim wins over base claim', () => {
    const m = findRoute(table, 'example.com', '/')
    expect(m).toMatchObject({ kind: 'routing', entry: { path: '/AppB' } })
  })

  // Setup:    the same table, but the routing winner is rejected by the accept predicate.
  // Action:   resolve while disallowing the routing entry.
  // Expected: resolution falls through to the base claim (AppA).
  test('falls through to base when routing target is ineligible', () => {
    const m = findRoute(table, 'example.com', '/', (entry) => entry.path !== '/AppB')
    expect(m).toMatchObject({ kind: 'base', entry: { path: '/AppA' } })
  })

  // Setup:    a non-matching URL.
  // Action:   resolve.
  // Expected: null.
  test('returns null when nothing matches', () => {
    expect(findRoute(table, 'other.com', '/')).toBe(null)
  })
})

test.describe('globsIntersect — building block', () => {
  test('basic cases', () => {
    expect(globsIntersect('abc', 'abc')).toBe(true)
    expect(globsIntersect('abc', 'abd')).toBe(false)
    expect(globsIntersect('a*', '*b')).toBe(true)
    expect(globsIntersect('a*', 'b*')).toBe(false)
    expect(globsIntersect('*', 'anything/at/all')).toBe(true)
  })
})