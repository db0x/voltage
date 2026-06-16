import { renderCard } from './cards.tpl.js'
import { normalizeCategories } from './category-list.js'

export function initCards({ i18n, tr, apps, toDisplayName, appDefaultSrc, icons, hiddenProfiles }, { showConfirm, openInfoDialog, showBuildOverlay, hideBuildOverlay, openEditDialog }) {
  // Card icons are consumed by cards.tpl.js via the icons object; cards.js itself only needs
  // the rclone icon for the dynamically-added rclone overlay badge after a build.
  const { rclone: rcloneSrc } = icons

  const grid = document.getElementById('grid')

  const addCard = document.createElement('div')
  addCard.className = 'card card-add'
  addCard.innerHTML = `<span class="plus">+</span>`

  // Shared across all cards — only one AppImage build can run at a time.
  // Exposed via getBuildRunning/setBuildRunning so the rebuild-notice dialog
  // can participate in the same mutual exclusion.
  let isBuildRunning = false

  function refreshMailHandlerBadge(app, card) {
    const badgesEl = card.querySelector('.badges')
    let badge = card.querySelector('[data-role="mail-handler-badge"]')
    const isHandler = app.mimeTypes?.includes('x-scheme-handler/mailto')
    if (!isHandler) {
      badge?.remove()
      return
    }
    if (!badge) {
      badge = document.createElement('span')
      badge.className = 'badge mail-handler'
      badge.dataset.role = 'mail-handler-badge'
      badgesEl.appendChild(badge)
    }
    badge.classList.toggle('active', !!app.isDefaultMailHandler)
    badge.textContent = app.isDefaultMailHandler ? `${i18n.badgeMailHandler} ✓` : i18n.badgeMailHandler
  }

  function createCard(app) {
    const hostname = (() => { try { return new URL(app.url).hostname } catch { return app.url } })()
    const name = app.name || toDisplayName(app.profile)

    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.profile   = app.profile
    card.dataset.private   = app.isPrivate ? 'true' : 'false'
    card.dataset.installed = app.installed ? 'true' : 'false'
    // An app can belong to multiple categories; store the normalised list as JSON so the drawer
    // filter can test membership (and names may contain spaces).
    card.dataset.categories = JSON.stringify(normalizeCategories(app.category))
    card.dataset.sortname  = name.toLowerCase()
    const iconSrc = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc

    card.innerHTML = renderCard({ name, hostname, iconSrc, app, i18n, tr, icons })

    const iconWrap = card.querySelector('.card-icon-wrap')
    const iconEl   = iconWrap.querySelector('img')
    iconWrap.addEventListener('click', () => {
      if (app.built && app.installed) window.managerAPI.launchApp(app.profile)
    })

    card.querySelector('[data-action="info"]')?.addEventListener('click', () => openInfoDialog(app, name))

    card.querySelector('[data-action="edit"]')?.addEventListener('click', () => {
      openEditDialog(app, async (updatedApp, { rebuild, install }) => {
        Object.assign(app, updatedApp)
        const newName = app.name || toDisplayName(app.profile)
        const newHostname = (() => { try { return new URL(app.url).hostname } catch { return app.url } })()
        card.dataset.sortname = newName.toLowerCase()
        // Keep the category dataset in sync so the drawer's category filters (which read it) reflect
        // an edit that added/removed categories.
        card.dataset.categories = JSON.stringify(normalizeCategories(app.category))
        card.querySelector('.name').textContent = newName
        card.querySelector('.url').textContent  = newHostname
        iconEl.alt = newName
        iconEl.src = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
        iconWrap.className = `card-icon-wrap ${app.built && app.installed ? 'launchable' : 'unavailable'}`
        refreshMailHandlerBadge(app, card)
        // Rebuild now always installs afterwards too — the edit confirm no longer asks
        // separately, matching the combined build-and-install card button.
        if (rebuild) {
          const built = await doBuild(true)
          if (built) await doInstall()
        }
      })
    })

    card.querySelector('[data-action="delete"]')?.addEventListener('click', async () => {
      const toggles = []
      if (app.isPrivate) toggles.push({ key: 'deleteConfig',      label: i18n.confirmDeleteConfig })
      toggles.push(      { key: 'deleteProfileData', label: i18n.confirmDeleteProfileData, defaultOn: false })
      const { confirmed, deleteConfig, deleteProfileData } = await showConfirm(
        tr('confirmDeleteMsg', { name }),
        { toggles }
      )
      if (!confirmed) return
      const btn = card.querySelector('[data-action="delete"]')
      btn.disabled = true
      btn.classList.add('loading')
      const result = await window.managerAPI.deleteApp({ profile: app.profile, configLabel: app.configLabel, deleteConfig, deleteProfileData })
      btn.classList.remove('loading')
      if (result.success) {
        if (deleteConfig) {
          // If the deleted private config overrode an embedded one, restore the embedded card.
          if (result.restoredApp) {
            const embeddedCard = createCard(result.restoredApp)
            card.remove()
            insertCard(embeddedCard)
          } else {
            card.remove()
          }
        } else {
          app.built = false
          app.installed = false
          card.dataset.installed = 'false'
          card.querySelector('[data-role="build-badge"]').textContent = i18n.badgeNotBuilt
          card.querySelector('[data-role="build-badge"]').classList.replace('built', 'not-built')
          card.querySelector('[data-action="build-install"]').dataset.tooltip = tr('btnBuildInstall', { name })
          card.querySelector('[data-role="install-badge"]')?.remove()
          iconWrap.classList.replace('launchable', 'unavailable')
        }
      } else {
        btn.disabled = false
      }
    })

    // Combined action: build then install in one click — long-term you always do both, so the
    // card offers a single "(re)build and install" button instead of two separate steps.
    card.querySelector('[data-action="build-install"]')?.addEventListener('click', async () => {
      const built = await doBuild(true)
      if (built) await doInstall()
    })

    // installing=true → the overlay text says "building and installing" (the combined card
    // action and the edit-rebuild flow both install afterwards).
    async function doBuild(installing = false) {
      if (isBuildRunning) return false
      isBuildRunning = true
      const currentName = app.name || toDisplayName(app.profile)
      showBuildOverlay(currentName, installing ? 'buildingInstallingApp' : 'buildingApp')
      const btn   = card.querySelector('[data-action="build-install"]')
      const badge = card.querySelector('[data-role="build-badge"]')
      btn.disabled = true
      btn.classList.add('loading')
      const result = await window.managerAPI.buildApp(app.configLabel)
      btn.disabled = false
      btn.classList.remove('loading')
      isBuildRunning = false
      hideBuildOverlay()
      if (result.success) {
        app.built = true
        app.needsRebuild = false
        badge.textContent = i18n.badgeBuilt
        badge.classList.replace('not-built', 'built')
        btn.dataset.tooltip = tr('btnRebuildInstall', { name })
        card.querySelector('[data-action="delete"]')?.removeAttribute('disabled')
        card.querySelector('[data-role="outdated-badge"]')?.remove()
        // Sync rclone overlay badge with the freshly written .version file
        app.builtRclone = result.builtRclone
        const wrap = card.querySelector('.card-icon-wrap')
        const hasBadge = !!wrap.querySelector('.rclone-badge')
        if (app.builtRclone && !hasBadge && rcloneSrc) {
          const span = document.createElement('span')
          span.className = 'rclone-badge'
          span.innerHTML = `<img src="${rcloneSrc}" alt="">`
          wrap.appendChild(span)
        } else if (!app.builtRclone && hasBadge) {
          wrap.querySelector('.rclone-badge').remove()
        }
      }
      return result.success
    }

    // opts.silent skips the interactive mail-handler prompt — used by the category bulk rebuild,
    // where prompting per app would be unbearable; it then installs without touching the default
    // mailto handler.
    async function doInstall(opts = {}) {
      const { silent = false } = opts
      const btn = card.querySelector('[data-action="build-install"]')
      if (!btn) return false

      let setAsMailHandler = false
      if (!silent && app.mimeTypes?.includes('x-scheme-handler/mailto')) {
        const { confirmed, setMailHandler } = await showConfirm(
          tr('installConfirmMsg', { name }),
          {
            okLabel: i18n.installConfirmOk,
            okClass: 'btn-save',
            toggle: { key: 'setMailHandler', label: i18n.installSetMailHandler, defaultOn: !app.isDefaultMailHandler },
          }
        )
        if (!confirmed) return false
        setAsMailHandler = setMailHandler
      }

      btn.disabled = true
      btn.classList.add('loading')
      const result = await window.managerAPI.installApp(app.configLabel, setAsMailHandler)
      btn.classList.remove('loading')
      btn.disabled = false
      if (result.success) {
        app.installed = true
        card.dataset.installed = 'true'
        iconWrap.classList.replace('unavailable', 'launchable')
        const buildBadge = card.querySelector('[data-role="build-badge"]')
        if (!card.querySelector('[data-role="install-badge"]')) {
          const installBadge = document.createElement('span')
          installBadge.className = 'badge installed'
          installBadge.dataset.role = 'install-badge'
          installBadge.textContent = i18n.badgeInstalled
          buildBadge.insertAdjacentElement('afterend', installBadge)
        }
        if (app.mimeTypes?.includes('x-scheme-handler/mailto')) {
          document.querySelectorAll('[data-role="mail-handler-badge"]').forEach(b => {
            b.classList.remove('active')
            b.textContent = i18n.badgeMailHandler
          })
          app.isDefaultMailHandler = setAsMailHandler
          refreshMailHandlerBadge(app, card)
        }
      }
      return result.success
    }

    // Expose this card's build/install steps on the element so the drawer's per-category bulk
    // rebuild can drive them without a separate registry to keep in sync (they vanish with the card).
    card._voltageOps = { doBuild, doInstall }

    return card
  }

  // Returns the rendered cards whose category list contains `category`.
  function cardsInCategory(category) {
    return [...grid.querySelectorAll('.card[data-private]')].filter(card => {
      try { return JSON.parse(card.dataset.categories || '[]').includes(category) } catch { return false }
    })
  }

  function categoryAppCount(category) {
    return cardsInCategory(category).length
  }

  // Rebuilds and installs every app in a category, sequentially (AppImage builds are mutually
  // exclusive). Skips the per-app mail-handler prompt. No-op if a build is already running.
  async function rebuildInstallCategory(category) {
    if (isBuildRunning) return
    for (const card of cardsInCategory(category)) {
      const ops = card._voltageOps
      if (!ops) continue
      const built = await ops.doBuild(true)
      if (built) await ops.doInstall({ silent: true })
    }
  }

  function insertCard(card) {
    const sortname = card.dataset.sortname
    const existing = [...grid.querySelectorAll('.card[data-sortname]')]
    const before = existing.find(c => c.dataset.sortname > sortname)
    grid.insertBefore(card, before ?? addCard)
  }

  for (const app of apps) {
    if (!hiddenProfiles?.has(app.profile)) grid.appendChild(createCard(app))
  }
  grid.appendChild(addCard)

  // Syncs card visibility with a new set of globally hidden profiles.
  // Newly hidden apps lose their card; newly shown apps get one inserted.
  function applyHiddenProfiles(newProfiles) {
    const newSet = new Set(newProfiles)
    for (const app of apps) {
      if (app.isPrivate) continue  // only embedded apps are hideable
      const card = grid.querySelector(`.card[data-profile="${CSS.escape(app.profile)}"]`)
      const shouldHide = newSet.has(app.profile)
      if (shouldHide && card) {
        card.remove()
      } else if (!shouldHide && !card) {
        insertCard(createCard(app))
      }
    }
    hiddenProfiles?.clear()
    newSet.forEach(p => hiddenProfiles?.add(p))
  }

  // Updates all mail-handler badges to reflect a new system default.
  // Called after the mail-handler dialog saves so cards stay in sync without a reload.
  function setDefaultMailHandler(profile) {
    for (const app of apps) {
      if (!app.mimeTypes?.includes('x-scheme-handler/mailto')) continue
      app.isDefaultMailHandler = app.profile === profile
      const card = grid.querySelector(`.card[data-profile="${CSS.escape(app.profile)}"]`)
      if (card) refreshMailHandlerBadge(app, card)
    }
  }

  return { createCard, insertCard, addCard,
    getBuildRunning: () => isBuildRunning,
    setBuildRunning: v  => { isBuildRunning = v },
    setDefaultMailHandler,
    applyHiddenProfiles,
    categoryAppCount,
    rebuildInstallCategory,
  }
}
