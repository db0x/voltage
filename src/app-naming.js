// Central naming helper. Maps a build profile to the user-facing artifact name (e.g. "v<Profile>").
//
// The build profile (lowercase kebab, e.g. "teams") stays the stable identity used for
// userData paths, config keys and extraMetadata.profile — only the USER-FACING artifact
// name (AppImage file, .desktop entry, installed icon) is derived from it via appName().
// Keeping these two concepts separate is what lets us rename the product without migrating
// any user data. The WM class / Wayland app_id is a third, lowercased form — see wmClass().
//
// profileFromAppName() is the inverse, used at runtime to recover the profile from an
// AppImage filename (routing parses sibling AppImage basenames).

// "teams" → "vTeams". Only the first letter is upper-cased so hyphenated profiles like
// "google-docs" become "vGoogle-docs" (matching the inverse below).
function appName(profile) {
  return 'v' + profile.charAt(0).toUpperCase() + profile.slice(1)
}

// "vTeams" → "teams", "vGoogle-docs" → "google-docs".
function profileFromAppName(name) {
  const m = /^v(.+)/.exec(name)
  return m ? m[1].charAt(0).toLowerCase() + m[1].slice(1) : name
}

// The WM class / Wayland app_id used for window↔launcher matching. Chromium derives the Wayland
// app_id from the program name and FORCES it lowercase (vTeams → vteams), and GNOME matches it
// case-sensitively against the .desktop StartupWMClass (and against "<app_id>.desktop"). So the
// matching token must be the lowercased artifact name — otherwise GNOME can't associate the
// window with its launcher and falls back to showing the raw lowercase id. Kept separate from
// appName() on purpose: the user-facing file/icon names stay capitalised (vTeams), only the
// matching key is lowercased.
function wmClass(profile) {
  return appName(profile).toLowerCase()
}

module.exports = { appName, profileFromAppName, wmClass }
