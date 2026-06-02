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