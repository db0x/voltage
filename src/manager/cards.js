export function initCards({ i18n, tr, apps, toDisplayName, appDefaultSrc, icons }, { showConfirm, openInfoDialog, showBuildOverlay, hideBuildOverlay, openEditDialog }) {
  const { info: infoSrc, build: buildSrc, install: installSrc, delete: deleteSrc, edit: editSrc, rclone: rcloneSrc } = icons

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
    card.dataset.category  = app.category || ''
    card.dataset.sortname  = name.toLowerCase()
    const iconSrc = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc

    card.innerHTML = `
      <div class="card-icon-wrap ${app.built && app.installed ? 'launchable' : 'unavailable'}">
        <img src="${iconSrc}" alt="${name}">
        ${app.builtRclone && rcloneSrc ? `<span class="rclone-badge"><img src="${rcloneSrc}" alt=""></span>` : ''}
      </div>
      <span class="name">${name}</span>
      <span class="url">${hostname}</span>
      <div class="badges">
        <span class="badge ${app.built ? 'built' : 'not-built'}" data-role="build-badge">${app.built ? i18n.badgeBuilt : i18n.badgeNotBuilt}</span>
        ${app.installed ? `<span class="badge installed" data-role="install-badge">${i18n.badgeInstalled}</span>` : ''}
        ${app.isPrivate ? `<span class="badge private">${i18n.badgeUser}</span>` : ''}
        ${app.needsRebuild ? `<span class="badge outdated" data-role="outdated-badge">${i18n.badgeOutdated}</span>` : ''}
        ${app.mimeTypes?.includes('x-scheme-handler/mailto') ? `<span class="badge mail-handler${app.isDefaultMailHandler ? ' active' : ''}" data-role="mail-handler-badge">${i18n.badgeMailHandler}${app.isDefaultMailHandler ? ' ✓' : ''}</span>` : ''}
      </div>
      <div class="card-toolbar">
        ${!app.isPrivate ? `<button class="toolbar-btn" data-action="info"    data-tooltip="${i18n.btnInfo}">${infoSrc    ? `<img src="${infoSrc}"    alt="${i18n.btnInfo}">` : ''}</button>` : ''}
        ${app.isPrivate  ? `<button class="toolbar-btn" data-action="edit"    data-tooltip="${i18n.btnEdit}">${editSrc    ? `<img src="${editSrc}"    alt="${i18n.btnEdit}">` : ''}</button>` : ''}
        <button class="toolbar-btn" data-action="build"   data-tooltip="${app.built ? i18n.btnRebuild : i18n.btnBuild}">${buildSrc   ? `<img src="${buildSrc}"   alt="Build">` : ''}</button>
        <button class="toolbar-btn" data-action="install" data-tooltip="${app.installed ? tr('btnReinstallTooltip', { name }) : tr('btnInstallTooltip', { name })}" ${app.built ? '' : 'disabled'}>${installSrc ? `<img src="${installSrc}" alt="${i18n.btnInstall}">` : ''}</button>
        <button class="toolbar-btn danger" data-action="delete" data-tooltip="${i18n.btnDelete}" ${app.built ? '' : 'disabled'}>${deleteSrc  ? `<img src="${deleteSrc}"  alt="${i18n.btnDelete}">` : ''}</button>
      </div>
    `

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
        card.querySelector('.name').textContent = newName
        card.querySelector('.url').textContent  = newHostname
        iconEl.alt = newName
        iconEl.src = app.iconPath ? `file://${app.iconPath}` : appDefaultSrc
        iconWrap.className = `card-icon-wrap ${app.built && app.installed ? 'launchable' : 'unavailable'}`
        refreshMailHandlerBadge(app, card)
        if (rebuild) {
          const built = await doBuild()
          if (built && install) await doInstall()
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
          card.remove()
        } else {
          app.built = false
          app.installed = false
          card.dataset.installed = 'false'
          card.querySelector('[data-role="build-badge"]').textContent = i18n.badgeNotBuilt
          card.querySelector('[data-role="build-badge"]').classList.replace('built', 'not-built')
          card.querySelector('[data-action="build"]').dataset.tooltip = i18n.btnBuild
          card.querySelector('[data-action="install"]')?.setAttribute('disabled', '')
          card.querySelector('[data-role="install-badge"]')?.remove()
          iconWrap.classList.replace('launchable', 'unavailable')
        }
      } else {
        btn.disabled = false
      }
    })

    card.querySelector('[data-action="install"]')?.addEventListener('click', () => doInstall())

    async function doBuild() {
      if (isBuildRunning) return false
      isBuildRunning = true
      const currentName = app.name || toDisplayName(app.profile)
      showBuildOverlay(currentName)
      const btn   = card.querySelector('[data-action="build"]')
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
        btn.dataset.tooltip = i18n.btnRebuild
        card.querySelector('[data-action="install"]')?.removeAttribute('disabled')
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

    async function doInstall() {
      const btn = card.querySelector('[data-action="install"]')
      if (!btn || btn.disabled) return false

      let setAsMailHandler = false
      if (app.mimeTypes?.includes('x-scheme-handler/mailto')) {
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
        btn.dataset.tooltip = tr('btnReinstallTooltip', { name })
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

    card.querySelector('[data-action="build"]')?.addEventListener('click', () => doBuild())

    return card
  }

  function insertCard(card) {
    const sortname = card.dataset.sortname
    const existing = [...grid.querySelectorAll('.card[data-sortname]')]
    const before = existing.find(c => c.dataset.sortname > sortname)
    grid.insertBefore(card, before ?? addCard)
  }

  for (const app of apps) {
    grid.appendChild(createCard(app))
  }
  grid.appendChild(addCard)

  return { createCard, insertCard, addCard,
    getBuildRunning: () => isBuildRunning,
    setBuildRunning: v  => { isBuildRunning = v },
  }
}
