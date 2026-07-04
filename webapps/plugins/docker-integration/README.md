# docker-integration plugin

Routes a voltage app to a **locally running Docker container** instead of its online service — e.g.
a self-hosted draw.io on `localhost` instead of `app.diagrams.net`. The AppImage owns the whole
container lifecycle: it brings the stack up before the window loads, waits until the service actually
answers, routes the window to the container's URL, and tears the stack down again when the last
window closes.

> **Heads-up on suitability:** container start/stop time is the price of this model. Lightweight
> single-container services (draw.io) feel instant after the first image pull; heavyweight stacks are
> a poor fit — a local OnlyOffice DocumentServer stack was built, worked end-to-end, and was then
> **dropped again** because its start/stop times made local single-user use miserable. The rich-stack
> machinery it motivated (materialization, config-owned env/secrets, `waitFor`) remains and is tested.

## Using it

1. In the Manager's create/edit dialog, add **docker-integration** to the app's plugins.
   The plugin is **greyed out (unselectable)** when neither Docker + Compose v2 (`docker compose`)
   nor legacy v1 (`docker-compose`) is usable on the system.
2. Open the plugin's gear dialog and pick a **stack** (icon + label rows; a read-only, syntax-
   highlighted preview shows the stack's compose file).
3. Save. The app's **URL field is locked** and shows `-docker-` while this plugin is selected — the
   plugin derives the real URL at launch; the baked `url` is kept untouched as the online fallback
   (and its **path + query survive** onto the container URL, so `…/edit/foo.docx` still lands on
   `http://localhost:<port>/edit/foo.docx`).
4. Rebuild the AppImage (plugin selection and `pluginConfig` are baked at build time).

On every launch the window first shows an in-window "starting…" page (docker glyph + container hint,
same mechanism as the error page — never a separate window), then navigates to the container.

## Curated stacks (`stacks/<id>/`)

A stack is a directory shipping `compose.yaml` **or** `compose.yml` plus a `stack.json` describing it:

```jsonc
{
    "label": "draw.io",                        // chooser label (default: dir name)
    "icon": "assets/webapps/drawio.svg",       // chooser icon, repo-root-relative (default: docker.svg)
    "service": "drawio",                       // compose service the window is routed to
    "containerPort": 8080,                     // that service's container-internal port
    "healthPath": "/",                         // readiness probe path on the routed service
    "portRange": [18000, 18099],               // optional host-port search range (this is the default)
    "env": { "SOME_VAR": "default" },          // env defaults, seeded into the app config on save
    "secrets": ["JWT_SECRET"],                 // secret names, generated (64-hex) into the config on save
    "createDirs": ["documents"],               // bind-mount sources to pre-create (else docker makes them root-owned)
    "waitFor": [                               // extra readiness gates beyond the routed service
        { "portEnv": "DS_PORT", "path": "/healthcheck", "timeoutMs": 90000 }
    ]
}
```

The compose file parameterizes everything host-specific with `${VARS}`; voltage always provides
`VOLTAGE_PORT` (the auto-assigned host port — give it a default like `${VOLTAGE_PORT:-8080}` so the
file also works standalone). A stack is **"rich"** when it ships more than compose + stack.json
(build contexts, config templates, …) — see *Materialization* below.

## Per-app config (`pluginConfig`)

```jsonc
"plugins/docker-integration/docker-integration.js": {
    "stack": "drawio",              // curated stack id
    "env": {                        // single source of the stack environment (see below)
        "USER_NAME": "Thomas",
        "JWT_SECRET": "…64 hex…"
    },
    "port": 18080,                  // OPTIONAL fixed host port (default: auto — next free in range)
    "composeFile": "/path/x.yml",   // OPTIONAL power-user compose file; overrides the stack
    "dataDir": "/path/data"         // OPTIONAL, passed as VOLTAGE_DATA_DIR
}
```

**The config is the single source of the stack environment — there is no machine-local `.env`.**
On Manager save, the generic `completeConfig` hook (run by `buildAppCfg` for any plugin exporting it)
seeds the stack's `env` defaults for unset keys and generates every declared-but-missing secret
(64-hex) **once**; existing values are never touched, so secrets stay stable across saves/rebuilds
(regenerating would orphan the containers' persisted state). `build.private.*.json` is gitignored, so
persisted secrets don't leak into the repo — but they **are baked into the AppImage's package.json**,
so don't hand such an AppImage around.

Env precedence at launch: stack `env` defaults < config `env` < `VOLTAGE_PORT` (always voltage-owned).
A declared secret still missing at launch (config never saved through the Manager) gets an
*ephemeral* value plus a log nudge — better than silently signing with an empty string.

## Runtime behaviour (resolveLaunch)

1. **Reuse:** if the compose project (`voltage-<profile>`) is already up (second window, leftover
   from a crash), its published port is reused and the container is **not** considered owned — it
   will not be torn down by this process.
2. **Auto-port:** first free port in `portRange` (default 18000–18099), probed by binding; a port
   conflict at `up` time (probe/up race) retries once with a fresh port. A user-fixed `port` never
   retries — a conflict there is a real error → online fallback.
3. **`compose up -d`** (may pull/build for minutes on first launch — the splash covers this).
4. **Readiness:** the routed service's `healthPath` is polled, then every `waitFor` gate.
   **Ready means an HTTP status < 400** — a 502 must *not* count: OnlyOffice's DocumentServer fronts
   itself with nginx that answers 502 within seconds while the actual service boots for another
   30–60 s, which used to produce a "ready" blank page.
5. The window loads `http://localhost:<port><path+query of pkg.url>`.
6. **Teardown:** window refcount; when the last window closes *and* this process started the stack,
   `compose down` runs synchronously (async would be killed by process exit). Errors never block quit.

Every step logs under the `[docker-integration]` prefix — launch the AppImage from a terminal to see
exactly where a failing start gives up. Any failure returns `null` → the app falls back to its baked
online `url` (or the error page).

## How the compose file reaches docker

Three delivery shapes, chosen automatically (`composeSpecFor`):

| stack shape | delivery | why |
|---|---|---|
| bundled, single file | **stdin** (`docker compose -f -`) | the file lives inside `app.asar`, which the external docker process cannot read; snap-confined docker additionally cannot read hidden `$HOME` paths and has a private `/tmp`. Piping the content dodges all of it |
| bundled, **rich** | **materialized dir**, referenced by path | stdin can't carry build contexts / config templates; relative `./paths` must resolve. Target: `~/snap/docker/common/voltage-stacks/<id>` for snap docker (its `$SNAP_USER_COMMON` is always readable), else `~/.config/voltage/docker-stacks/<id>`. Re-copied on every launch (bundled updates propagate); `stack.json` is dropped; a stray source `.env` is **never** copied (dev-secret leak guard); a stale target `.env` is deleted (it would shadow config values via compose's auto-read) |
| custom `composeFile` | its real path | the user owns the file and its location |

Compose v1 (`docker-compose`, no dependable stdin, never snap) gets bundled single-file content via a
temp file in `/tmp` instead, cleaned up on teardown.

## Environment robustness

- **PATH:** GUI-launched AppImages often lack `/snap/bin` (and friends) in `PATH`; every docker call
  runs with `/usr/local/bin:/usr/bin:/bin:/snap/bin` prepended so docker resolves like in a shell.
- **Compose detection** (`detectCompose`): v2 `docker compose` preferred, v1 `docker-compose`
  fallback (common on apt installs). The Manager's availability check delegates to the *same*
  detection, so "selectable" and "actually starts" can never disagree.
- All compose subcommands (also `port`/`down`) receive the env, so compose's `${VAR}` parsing never
  spams unset-variable warnings.

## Framework hooks this plugin exercises

Generic seams (usable by any plugin) that were introduced with this integration:

| hook / flag | where consumed | effect |
|---|---|---|
| `available()` → `{ available, reason }` | Manager plugin discovery | greyed-out, unselectable list entry with a localized tooltip when prerequisites are missing |
| `managesUrl: true` | create/edit dialogs | URL field locked (`-docker-` marker in edit; real URL preserved on save) |
| `stacks()` | discovery → config dialog | fills the `data-config-stacks` icon chooser + `data-config-stack-preview` highlighted preview |
| `launchInfo(pkg, {config, i18n})` | app-window.js | icon/title/hint for the in-window "starting…" page |
| `resolveLaunch(pkg, {config})` | app-window.js (async pre-launch seam) | resolves the real URL before the window loads; `null` = fallback to `pkg.url` |
| `completeConfig(config)` | `buildAppCfg` on Manager save | normalise/complete per-app plugin config (env defaults, generated secrets) |

## Tests

- `tests/docker-container.spec.js` — node-level: port finder, resolveLaunch fallbacks, `.yml`
  acceptance, materialization (no `.env`, leak guard), `completeConfig` idempotence, env merge
  order, `waitFor` resolution. Uses throwaway temp stacks under `stacks/`.
- `tests/docker-integration.spec.js` — Manager e2e: availability grey-out, stack chooser + preview,
  config round-trip, URL lock. `VOLTAGE_TEST_DOCKER=1|0` forces the availability probe so tests are
  deterministic without a real Docker install.

The compose calls themselves need a real daemon and are not exercised in CI; the v1
(`docker-compose`) delivery path has not been verified against a live v1 install.
