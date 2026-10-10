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
2. Open the plugin's gear dialog and pick a **stack** from the dropdown (icon + label per entry; a
   read-only, syntax-highlighted preview shows the chosen stack's compose file). A stack declaring
   `pathConfigurable` additionally shows a **Path** field — a fixed route appended after
   `localhost:<port>`, for a stack template several apps each launch their own container from.
   Single-purpose stacks (e.g. draw.io) don't show it — there is nothing to route between.
3. Save. The app's **URL field is locked** and shows `-docker-` while this plugin is selected — the
   plugin derives the real URL at launch; the baked `url` is kept untouched as the online fallback
   (and its **path + query survive** onto the container URL, so `…/edit/foo.docx` still lands on
   `http://localhost:<port>/edit/foo.docx` — unless a Path override is set, which takes priority).
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
    "createDirs": ["documents", "${VOLTAGE_DATA_DIR}"],  // bind-mount sources to pre-create (see below)
    "waitFor": [                               // extra readiness gates beyond the routed service
        { "portEnv": "DS_PORT", "path": "/healthcheck", "timeoutMs": 90000 }
    ],
    "readyDelayMs": 4000,                      // extra fixed settle time after healthPath + waitFor pass (see below)
    "pathConfigurable": true                   // shows the config dialog's Path field for this stack (see below)
}
```

**`createDirs`** names the bind-mount sources that must exist *before* `up`: docker creates a missing
bind source itself, as root, which is exactly what leaves a pinned-user container unable to write its
own data directory. An entry is either **relative** — resolved against a rich stack's materialized
directory, created during materialization — or **absolute** once its `${VARS}` are expanded from the
compose environment, which is the shape for a real host path such as `${VOLTAGE_DATA_DIR}`. Absolute
entries are created on every launch, for every stack shape (not just rich ones). Best-effort: a path
that cannot be created is left to docker, which then fails loudly at `up`.

The compose file parameterizes everything host-specific with `${VARS}`; voltage always provides
`VOLTAGE_PORT` (the auto-assigned host port — give it a default like `${VOLTAGE_PORT:-8080}` so the
file also works standalone). A stack is **"rich"** when it ships more than compose + stack.json
(build contexts, config templates, …) — see *Materialization* below.

### Shipped stacks

| id | what it routes to | notes |
|---|---|---|
| `drawio` | `jgraph/drawio` | single stateless container, nothing to configure |
| `trivialslides` | the trivialSlides deck editor | **builds from source** — see below |

**`trivialslides`** has no published image: it is built from its own repository, wherever that is
checked out. Two per-app values are therefore required and the compose file demands both with
`${VAR:?message}`, so a missing one fails at `up` with a line worth reading rather than something
obscure:

```jsonc
"plugins/docker-integration/docker-integration.js": {
    "stack": "trivialslides",
    "dataDir": "/home/you/Documents/slides",          // host folder the decks live in (bind-mounted)
    "env": {
        "TRIVIALSLIDES_SRC": "/home/you/trivialSlides" // the checkout; its ./backend is the build context
    }
}
```

The compose file carries `image:` *alongside* `build:`, so compose tags what it builds: the first
launch builds (minutes, covered by the in-window "starting…" page) and every later launch reuses the
tag. After changing the source, rebuild explicitly with
`docker compose -p voltage-<profile> build`. Set `AI_API`/`AI_KEY`/`AI_MODEL` in `env` to enable the
deck-from-a-prompt feature; left empty the feature is simply absent.

Unlike the upstream compose file this stack sets **no `container_name`** — see the note on concurrent
instances above; here it also matters because the same stack may be running from the repo by hand.

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
    "dataDir": "/path/data",        // OPTIONAL, passed as VOLTAGE_DATA_DIR
    "path": "/play/tentacle"        // OPTIONAL fixed route (config dialog field); see below
}
```

**The config is the single source of the stack environment — there is no machine-local `.env`.**
On Manager save, the generic `completeConfig` hook (run by `buildAppCfg` for any plugin exporting it)
seeds the stack's `env` defaults for unset keys and generates every declared-but-missing secret
(64-hex) **once**; existing values are never touched, so secrets stay stable across saves/rebuilds
(regenerating would orphan the containers' persisted state). `build.private.*.json` is gitignored, so
persisted secrets don't leak into the repo — but they **are baked into the AppImage's package.json**,
so don't hand such an AppImage around.

Env precedence at launch: stack `env` defaults < config `env` < `VOLTAGE_PORT`, `VOLTAGE_UID`,
`VOLTAGE_GID` (always voltage-owned). The latter two are the running account's numeric ids: a stack
that bind-mounts a host directory should pin `user: "${VOLTAGE_UID:-1000}:${VOLTAGE_GID:-1000}"`,
otherwise the container writes as root and the bind hands that straight through — the data then
belongs to root and cannot be edited or backed up without sudo. The AppImage runs as the very user
who owns those files, so it is the one place that knows the right numbers.
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
   30–60 s, which used to produce a "ready" blank page. Some services fail the OPPOSITE way — the
   HTTP status is fine long before the service is actually usable, e.g. a video-streamed desktop
   session serves its shell page instantly while the desktop behind it is still booting.
   `readyDelayMs` is a blunt fixed extra wait for exactly that case (only on a fresh start,
   never when reusing an already-running, already-settled container). Only ever a heuristic — tune it
   per stack by how long the service actually takes to become genuinely interactive.
5. The window loads `http://localhost:<port><suffix>`, where `<suffix>` is the config's `path`
   (normalised to a leading `/`) if set, else the baked `pkg.url`'s own path+query. `path` is for a
   fixed, per-app route (e.g. several apps sharing one stack template, each routed to its own
   sub-path); the `pkg.url` fallback is for apps whose entry page is inherently per-launch
   (e.g. a file association opening a specific document) — the two never apply together.
6. **Teardown:** window refcount; when the last window closes *and* this process started the stack,
   `compose down` is started **detached** (own process group, `unref`'d) so it outlives the quitting
   app instead of being killed with it. It used to run *synchronously* for that same reason, but that
   blocks Electron's main thread for however long docker takes — with the window already gone, the
   desktop then offers to kill the unresponsive app. The cost of detaching is ordering: relaunching
   inside the teardown window can briefly find the old container still going away. Errors never block
   quit. A compose **v1** temp file cannot be deleted by the detached child that is still reading it;
   stale ones are swept at the next launch.

**Slow teardown is almost always a missing init.** `compose down` runs when the last window closes,
and a container whose PID 1 ignores SIGTERM makes docker wait out its full grace period (10s by
default) before SIGKILL — on every app close. A process with PID 1 only *receives* signals it has an
explicit handler for, which an image doing `CMD ["node", "app.js"]` (or any other plain interpreter
entrypoint) does not have. Setting `init: true` on the service puts tini at PID 1 to forward the
signal; the app is then an ordinary process whose default disposition is to exit. For the
trivialSlides stack this took teardown from 10.7s to 0.7s. Images that already handle signals (a
servlet container, an entrypoint using `exec`) need nothing. Teardown is detached (see step 6), so a
slow one no longer freezes the app — but it still delays a relaunch, and `init: true` costs nothing.

**Running several apps built from the same stack template at once** (e.g. one app per game, sharing
one container image) needs each to actually get its own container — the compose file must NOT set a
fixed `container_name`. A fixed name is unique host-wide, across every compose *project*, so the
second app's `up` would collide with the first's already-running container regardless of the two
apps' own distinct `voltage-<profile>` projects. Left unset, compose derives the name from the project
instead, which is automatically unique per app — this is what actually makes concurrent instances
possible, not just the per-app port (`VOLTAGE_PORT`, already automatic — see *Auto-port* above) or
project name alone.

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
| `stacks()` | discovery → config dialog | fills the `data-config-stacks` icon+label combobox + `data-config-stack-preview` highlighted preview; also carries `pathConfigurable` per stack for `data-config-visible-if-stack` |
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
