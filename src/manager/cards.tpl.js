// Returns the innerHTML for a single app card. The outer <div class="card"> is
// managed by createCard() in cards.js, which also sets data attributes on it.
export function renderCard({ name, hostname, iconSrc, app, i18n, tr, icons }) {
  // install icon is used for the combined build-and-install button (the standalone build icon
  // is no longer needed since build and install are one action now).
  const { install: installSrc, delete: deleteSrc,
          info: infoSrc, edit: editSrc, rclone: rcloneSrc } = icons
  return `
    <div class="card-icon-wrap ${app.built && app.installed ? 'launchable' : 'unavailable'}">
      <img src="${iconSrc}" alt="${name}">
      ${app.builtRclone && rcloneSrc ? `<span class="rclone-badge"><img src="${rcloneSrc}" alt=""></span>` : ''}
    </div>
    <span class="name">${name}</span>
    <span class="url">${hostname}</span>
    <div class="badges">
      <span class="badge ${app.built ? 'built' : 'not-built'}" data-role="build-badge">
        ${app.built ? i18n.badgeBuilt : i18n.badgeNotBuilt}
      </span>
      ${app.installed ? `<span class="badge installed" data-role="install-badge">${i18n.badgeInstalled}</span>` : ''}
      ${app.isPrivate ? `<span class="badge private">${i18n.badgeUser}</span>` : ''}
      ${app.needsRebuild ? `<span class="badge outdated" data-role="outdated-badge">${i18n.badgeOutdated}</span>` : ''}
      ${app.mimeTypes?.includes('x-scheme-handler/mailto')
        ? `<span class="badge mail-handler${app.isDefaultMailHandler ? ' active' : ''}" data-role="mail-handler-badge">
             ${i18n.badgeMailHandler}${app.isDefaultMailHandler ? ' ✓' : ''}
           </span>`
        : ''}
    </div>
    <div class="card-toolbar">
      ${!app.isPrivate
        ? `<button class="toolbar-btn" data-action="info" data-tooltip="${i18n.btnInfo}">
             ${infoSrc ? `<img src="${infoSrc}" alt="${i18n.btnInfo}">` : ''}
           </button>`
        : ''}
      ${app.isPrivate
        ? `<button class="toolbar-btn" data-action="edit" data-tooltip="${i18n.btnEdit}">
             ${editSrc ? `<img src="${editSrc}" alt="${i18n.btnEdit}">` : ''}
           </button>`
        : ''}
      <button class="toolbar-btn" data-action="build-install"
              data-tooltip="${app.built ? tr('btnRebuildInstall', { name }) : tr('btnBuildInstall', { name })}">
        ${installSrc ? `<img src="${installSrc}" alt="${i18n.btnInstall}">` : ''}
      </button>
      <button class="toolbar-btn danger" data-action="delete" data-tooltip="${i18n.btnDelete}"
              ${app.built || app.isPrivate ? '' : 'disabled'}>
        ${deleteSrc ? `<img src="${deleteSrc}" alt="${i18n.btnDelete}">` : ''}
      </button>
    </div>`
}
