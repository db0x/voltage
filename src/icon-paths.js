// Locations of Voltage's installed app icons. Centralised so the build scripts (which install the
// icons) and the AppImage runtime (which reads them back for the window/About panel) never disagree.
//
// Voltage installs every app/launcher icon into its OWN freedesktop icon theme ("voltage") instead
// of the shared `hicolor` fallback theme. Writing into hicolor is dangerous: per the Icon Theme
// Specification, when a theme exists in several base dirs GTK reads the `Directories=` list ONLY from
// the highest-priority one (~/.local/share/icons/hicolor). A partial index there therefore shadows
// the complete system index and hides every system icon whose context isn't listed — breaking icons
// system-wide. A private theme that no other software ships overshadows nothing; it Inherits=hicolor
// so the normal fallback chain still works.

const os   = require('node:os')
const path = require('node:path')

const VOLTAGE_ICON_THEME = 'voltage'

function voltageIconThemeDir() {
  return path.join(os.homedir(), '.local', 'share', 'icons', VOLTAGE_ICON_THEME)
}

// Ordered [absPath, mimeType] candidates for an app's installed icon: the current private-theme
// layout first, then the legacy hicolor location so AppImages installed before the theme move still
// find their icon. A private app's icon copied from a system theme is often a .png, so both
// extensions are probed at each layout before falling back to the 48×48 raster.
function appIconCandidates(iconBase) {
  const layout = (base) => [
    [path.join(base, 'scalable', 'apps', `${iconBase}.svg`), 'image/svg+xml'],
    [path.join(base, 'scalable', 'apps', `${iconBase}.png`), 'image/png'],
    [path.join(base, '48x48',    'apps', `${iconBase}.png`), 'image/png'],
  ]
  const hicolor = path.join(os.homedir(), '.local', 'share', 'icons', 'hicolor')
  return [...layout(voltageIconThemeDir()), ...layout(hicolor)]
}

module.exports = { VOLTAGE_ICON_THEME, voltageIconThemeDir, appIconCandidates }
