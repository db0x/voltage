import { MarkdownView, Plugin, Notice } from 'obsidian'
import { readFileSync, existsSync } from 'fs'
import { join, basename } from 'path'
import { spawn, spawnSync } from 'child_process'
import { homedir } from 'os'

// Respect XDG_CONFIG_HOME if set — same logic as Electron's app.getPath('appData').
const CONFIG_HOME  = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
const ROUTING_FILE = join(CONFIG_HOME, 'wrapweb', 'plugins', 'routing', 'routing.json')

interface RouteTarget {
  path: string
  name?: string
  icon?: string
}

type Routing = Record<string, string | RouteTarget>

interface ResolvedRoute {
  appImagePath: string
  name: string
  iconDataUrl: string | null
}

// Re-read routing at most once per second to avoid disk I/O on every mouseover.
let routingCache: { ts: number; data: Routing } | null = null

function loadRouting(): Routing {
  const now = Date.now()
  if (routingCache && now - routingCache.ts < 1000) return routingCache.data
  try {
    const data = JSON.parse(readFileSync(ROUTING_FILE, 'utf8')) as Routing
    routingCache = { ts: now, data }
    return data
  } catch {
    return {}
  }
}

// --- Icon resolution (mirrors window.js logic) ---

// Looks up a PNG icon file by name in standard hicolor theme locations.
// Matches wrapweb's resolveIconPath — only PNG because SVG fails in some Electron contexts.
// For wrapweb app icons we also check for SVG since we're in a plain web context here.
function resolveIconPath(iconName: string, allowSvg = false): string | null {
  if (!iconName) return null
  const bases = [
    join(homedir(), '.local', 'share', 'icons', 'hicolor'),
    '/usr/share/icons/hicolor',
  ]
  for (const base of bases) {
    if (allowSvg) {
      const p = join(base, 'scalable', 'apps', `${iconName}.svg`)
      if (existsSync(p)) return p
    }
    for (const size of ['48x48', '32x32', '64x64', '256x256', '128x128']) {
      const p = join(base, size, 'apps', `${iconName}.png`)
      if (existsSync(p)) return p
    }
  }
  const pixmap = `/usr/share/pixmaps/${iconName}.png`
  if (existsSync(pixmap)) return pixmap
  return null
}

function pathToDataUrl(p: string): string | null {
  try {
    const mime = p.endsWith('.svg') ? 'image/svg+xml' : 'image/png'
    return `data:${mime};base64,${readFileSync(p, 'base64')}`
  } catch {
    return null
  }
}

// Resolves the icon for the default handler of a given MIME/scheme type.
// Mirrors resolveHandlerIconPath() in window.js.
function resolveHandlerIconDataUrl(mimeType: string): string | null {
  try {
    const r = spawnSync('xdg-mime', ['query', 'default', mimeType], { encoding: 'utf8', timeout: 500 })
    if (!r.stdout) return null
    const desktop = r.stdout.trim()
    const appDirs = [
      join(homedir(), '.local', 'share', 'applications'),
      '/usr/share/applications',
      '/usr/local/share/applications',
    ]
    let iconName = desktop.replace(/\.desktop$/, '')
    for (const dir of appDirs) {
      try {
        const match = readFileSync(join(dir, desktop), 'utf8').match(/^Icon=(.+)$/m)
        if (match) { iconName = match[1].trim(); break }
      } catch {}
    }
    const p = resolveIconPath(iconName)
    return p ? pathToDataUrl(p) : null
  } catch {
    return null
  }
}

// Lazily resolved once — xdg-mime result is stable for the session.
let _browserIconDataUrl: string | null | undefined = undefined
function getBrowserIconDataUrl(): string | null {
  if (_browserIconDataUrl !== undefined) return _browserIconDataUrl
  return (_browserIconDataUrl = resolveHandlerIconDataUrl('x-scheme-handler/https'))
}

// Per-AppImage icon data URL cache — icons don't change during a session.
const appIconCache = new Map<string, string | null>()

function getAppIconDataUrl(appImagePath: string): string | null {
  if (appIconCache.has(appImagePath)) return appIconCache.get(appImagePath)!
  const name = basename(appImagePath).replace(/\.(AppImage|appimage)$/, '')
  const p    = resolveIconPath(name, true) // allow SVG for wrapweb app icons
  const url  = p ? pathToDataUrl(p) : null
  appIconCache.set(appImagePath, url)
  return url
}

// --- Routing ---

function resolveRoute(url: string): ResolvedRoute | null {
  let hostname: string
  let pathname: string
  try {
    ;({ hostname, pathname } = new URL(url))
  } catch {
    return null
  }

  const routing = loadRouting()

  // Sort longer keys first so path-specific rules (e.g. docs.google.com/spreadsheets)
  // take priority over hostname-only rules (e.g. docs.google.com).
  const entry = Object.entries(routing)
    .sort((a, b) => b[0].length - a[0].length)
    .find(([key]) => {
      const slash = key.indexOf('/')
      if (slash !== -1) {
        const keyHost = key.slice(0, slash)
        const keyPath = '/' + key.slice(slash + 1)
        return (
          (hostname === keyHost || hostname.endsWith('.' + keyHost)) &&
          pathname.startsWith(keyPath)
        )
      }
      return hostname === key || hostname.endsWith('.' + key)
    })

  if (!entry) return null

  const target       = entry[1]
  const appImagePath = typeof target === 'string' ? target : target.path

  if (!existsSync(appImagePath)) return null

  const name =
    typeof target === 'object' && target.name
      ? target.name
      : basename(appImagePath).replace(/^wrapweb-/, '').replace(/-/g, ' ')

  return { appImagePath, name, iconDataUrl: getAppIconDataUrl(appImagePath) }
}

function openInWrapweb(route: ResolvedRoute, url: string): void {
  spawn(route.appImagePath, ['--no-sandbox', url], {
    detached: true,
    stdio: 'ignore',
  }).unref()
  new Notice(`Opening in ${route.name} …`)
}

// --- URL extraction from markdown ---

// Extracts an http(s) URL from a raw markdown line at the given character offset.
// Handles [text](url) links and bare URLs.
function extractUrlAt(text: string, offset: number): string | null {
  const linkRe = /\[([^\]]*)\]\((https?:\/\/[^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(text)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[2]
  }
  const urlRe = /https?:\/\/[^\s)>\]"]*/g
  while ((m = urlRe.exec(text)) !== null) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[0]
  }
  return null
}

// --- Tooltip CSS (identical to src/tooltip.css injected into app windows) ---

const TOOLTIP_CSS = `
#wrapweb-link-tooltip {
  position: fixed; bottom: 0; left: 50%; transform: translateX(-50%);
  z-index: 2147483647; max-width: 60%; padding: 3px 10px 4px;
  font: 12px/1.5 -apple-system, system-ui, sans-serif; color: #fff;
  background: rgba(30,30,30,0.85); border-top-left-radius: 5px;
  border-top-right-radius: 5px; pointer-events: none; display: none;
  backdrop-filter: blur(4px); align-items: center; gap: 6px; min-width: 0;
}
#wrapweb-link-tooltip img { width:14px; height:14px; flex-shrink:0; object-fit:contain; }
#wrapweb-link-tooltip span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; }
`

export default class WrapwebPlugin extends Plugin {
  private tipEl:    HTMLElement      | null = null
  private tipIcon:  HTMLImageElement | null = null
  private tipLabel: HTMLElement      | null = null
  private styleEl:  HTMLStyleElement | null = null

  async onload(): Promise<void> {
    this.styleEl          = document.head.createEl('style')
    this.styleEl.textContent = TOOLTIP_CSS

    this.tipEl    = document.body.createEl('div')
    this.tipEl.id = 'wrapweb-link-tooltip'
    this.tipIcon  = this.tipEl.createEl('img')
    this.tipIcon.alt = ''
    this.tipIcon.style.display = 'none'
    this.tipLabel = this.tipEl.createEl('span')

    // Pre-warm browser icon so it's ready before the first hover.
    setTimeout(() => getBrowserIconDataUrl(), 0)

    // Capture-phase listeners fire before Obsidian's bubble-phase link handlers.
    this.registerDomEvent(document, 'click',     this.onClick.bind(this),     { capture: true })
    this.registerDomEvent(document, 'mouseover', this.onMouseover.bind(this), { capture: true })
  }

  onunload(): void {
    this.tipEl?.remove()
    this.styleEl?.remove()
    this.tipEl    = null
    this.tipIcon  = null
    this.tipLabel = null
    this.styleEl  = null
  }

  // Shared URL extraction for both click and hover events.
  private urlFromEvent(evt: MouseEvent): string | null {
    const target = evt.target as Element

    // Reading Mode: links are real <a class="external-link"> elements.
    const anchor = target.closest?.('a.external-link') as HTMLAnchorElement | null
    if (anchor) return anchor.href

    // Live Preview: links are SPAN.cm-link > SPAN.cm-underline — no <a> in DOM.
    // The URL lives only in the CM6 document state; access without importing @codemirror
    // (an import would cause a multiple-instances crash).
    if (target.closest?.('.cm-link')) {
      const mdView   = this.app.workspace.getActiveViewOfType(MarkdownView)
      const cmEditor = (mdView?.editor as any)?.cm
      if (cmEditor) {
        const pos = cmEditor.posAtCoords({ x: evt.clientX, y: evt.clientY }, false)
        if (pos != null) {
          const line = cmEditor.state.doc.lineAt(pos)
          return extractUrlAt(line.text, pos - line.from)
        }
      }
    }

    return null
  }

  private onClick(evt: MouseEvent): void {
    if (evt.button !== 0) return
    const url = this.urlFromEvent(evt)
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) return
    const route = resolveRoute(url)
    if (!route) return
    evt.preventDefault()
    evt.stopImmediatePropagation()
    this.hideTooltip()
    openInWrapweb(route, url)
  }

  private onMouseover(evt: MouseEvent): void {
    const url = this.urlFromEvent(evt)
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      this.hideTooltip()
      return
    }
    // Wrapweb route → app icon; no route → browser icon.
    const route       = resolveRoute(url)
    const iconDataUrl = route ? route.iconDataUrl : getBrowserIconDataUrl()
    this.showTooltip(iconDataUrl, url)
  }

  private showTooltip(iconDataUrl: string | null, url: string): void {
    if (!this.tipEl || !this.tipIcon || !this.tipLabel) return
    if (iconDataUrl) {
      this.tipIcon.src = iconDataUrl
      this.tipIcon.style.display = ''
    } else {
      this.tipIcon.style.display = 'none'
    }
    this.tipLabel.textContent = url
    this.tipEl.style.display = 'flex'
  }

  private hideTooltip(): void {
    if (this.tipEl) this.tipEl.style.display = 'none'
  }
}
