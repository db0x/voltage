#!/usr/bin/env bash
set -euo pipefail

REPO="https://github.com/db0x/voltage.git"
DEFAULT_DEST="$HOME/.local/share/voltage"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"

# ── colours ──────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
else
  RED=''; YELLOW=''; GREEN=''; CYAN=''; BOLD=''; RESET=''
fi

info()  { echo -e "  ${CYAN}→${RESET} $*"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $*"; }
die()   { echo -e "  ${RED}✗${RESET} $*" >&2; exit 1; }
header(){ echo -e "\n${BOLD}$*${RESET}"; }

# ── distro detection ──────────────────────────────────────────────────────────
detect_pm() {
  if   command -v apt-get &>/dev/null; then PM=apt;    SUDO=sudo
  elif command -v dnf     &>/dev/null; then PM=dnf;    SUDO=sudo
  elif command -v pacman  &>/dev/null; then PM=pacman; SUDO=sudo
  elif command -v zypper  &>/dev/null; then PM=zypper; SUDO=sudo
  else                                      PM=unknown; SUDO=''
  fi
}

# pkg_hint <apt-pkg> <dnf-pkg> <pacman-pkg> <zypper-pkg> <description>
pkg_hint() {
  local apt_pkg="$1" dnf_pkg="$2" pac_pkg="$3" zyp_pkg="$4" desc="$5"
  case "$PM" in
    apt)    warn "$desc\n         sudo apt install $apt_pkg" ;;
    dnf)    warn "$desc\n         sudo dnf install $dnf_pkg" ;;
    pacman) warn "$desc\n         sudo pacman -S $pac_pkg" ;;
    zypper) warn "$desc\n         sudo zypper install $zyp_pkg" ;;
    *)      warn "$desc — install the appropriate package for your distro." ;;
  esac
}

# ── required: git ────────────────────────────────────────────────────────────
check_git() {
  if command -v git &>/dev/null; then ok "git"; return; fi

  warn "git not found."
  echo ""
  read -rp "  Install git now? [y/N] " _answer
  if [[ "$_answer" =~ ^[yY]$ ]]; then
    case "$PM" in
      apt)    sudo apt-get install -y git ;;
      dnf)    sudo dnf install -y git ;;
      pacman) sudo pacman -S --noconfirm git ;;
      zypper) sudo zypper install -y git ;;
      *)      die "Cannot install git automatically. Please install it manually and re-run." ;;
    esac
    ok "git installed"
  else
    die "git is required. Install it and re-run."
  fi
}

# ── required: npm ────────────────────────────────────────────────────────────
check_npm() {
  if command -v npm &>/dev/null; then ok "npm"; return; fi

  warn "npm not found."
  echo ""
  read -rp "  Install npm now? [y/N] " _answer
  if [[ "$_answer" =~ ^[yY]$ ]]; then
    case "$PM" in
      apt)    sudo apt-get install -y npm ;;
      dnf)    sudo dnf install -y npm ;;
      pacman) sudo pacman -S --noconfirm npm ;;
      zypper) sudo zypper install -y npm ;;
      *)      die "Cannot install npm automatically. Please install it manually and re-run." ;;
    esac
    ok "npm installed"
  else
    die "npm is required. Install it and re-run."
  fi
}

# ── required: node ≥ 20 ──────────────────────────────────────────────────────
install_node_via_nvm() {
  info "Installing nvm + Node.js LTS …"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm use --lts
  ok "Node.js $(node -e 'process.stdout.write(process.versions.node)') installed via nvm"
}

check_node() {
  if ! command -v node &>/dev/null; then
    warn "Node.js not found."
    echo ""
    read -rp "  Install Node.js LTS via nvm now? [y/N] " _answer
    if [[ "$_answer" =~ ^[yY]$ ]]; then
      install_node_via_nvm
    else
      die "Node.js is required. Install it from https://nodejs.org/ and re-run."
    fi
  fi
  local ver
  ver=$(node -e 'process.stdout.write(process.versions.node)')
  local major="${ver%%.*}"
  if [ "$major" -lt 20 ]; then
    die "Node.js $ver found, but ≥ 20 is required."
  fi
  ok "Node.js $ver"
}

# ── optional dependencies ─────────────────────────────────────────────────────
check_optional() {
  # AppImages require libfuse.so.2 (FUSE 2) — FUSE 3 alone is not sufficient.
  # On Ubuntu 22.04+ the package is libfuse2; on Ubuntu 24.04+ it is libfuse2t64.
  # dpkg-query is used on apt systems because ldconfig path varies across distros.
  _fuse2_ok=false
  case "$PM" in
    apt)
      if dpkg-query -W -f='${Status}' libfuse2t64 2>/dev/null | grep -q 'install ok installed' || \
         dpkg-query -W -f='${Status}' libfuse2    2>/dev/null | grep -q 'install ok installed'; then
        _fuse2_ok=true
      fi
      ;;
    *)
      # On non-apt systems fall back to searching for the library file
      if find /usr/lib /usr/lib64 /lib /lib64 -name 'libfuse.so.2*' 2>/dev/null | grep -q .; then
        _fuse2_ok=true
      fi
      ;;
  esac
  if $_fuse2_ok; then
    ok "libfuse2"
  else
    case "$PM" in
      apt)    warn "libfuse2 not found — AppImages cannot run.\n         sudo apt install libfuse2t64   # Ubuntu 24.04+\n         sudo apt install libfuse2      # Ubuntu 22.04 / Debian" ;;
      dnf)    warn "libfuse2 not found — AppImages cannot run.\n         sudo dnf install fuse-libs" ;;
      pacman) warn "libfuse2 not found — AppImages cannot run.\n         sudo pacman -S fuse2" ;;
      zypper) warn "libfuse2 not found — AppImages cannot run.\n         sudo zypper install libfuse2" ;;
      *)      warn "libfuse2 not found — AppImages cannot run. Install libfuse2 for your distro." ;;
    esac
  fi

  if ! python3 -c 'import gi' &>/dev/null 2>&1; then
    pkg_hint "python3-gi" "python3-gobject" "python-gobject" "python3-gobject" \
      "python3-gi not found — icon theme integration unavailable."
  else
    ok "python3-gi"
  fi

  if ! command -v aspell &>/dev/null; then
    pkg_hint "aspell" "aspell" "aspell" "aspell" \
      "aspell not found — spell-check suggestions unavailable (optional)."
  else
    ok "aspell"
  fi
}

# ── clone or update ───────────────────────────────────────────────────────────
install_or_update() {
  local dest="$1"

  if [ -d "$dest/.git" ]; then
    info "Updating existing installation at $dest …"
    git -C "$dest" checkout -- package-lock.json 2>/dev/null || true
    git -C "$dest" pull --ff-only
    ok "Repository updated"
  else
    info "Cloning $REPO → $dest …"
    git clone --depth=1 "$REPO" "$dest"
    ok "Repository cloned"
  fi

  info "Installing npm dependencies …"
  npm install --prefix "$dest" --silent
  ok "Dependencies installed"
}

# ── desktop entry for the manager ────────────────────────────────────────────
install_desktop_entry() {
  local dest="$1"

  mkdir -p "$ICON_DIR"
  cp "$dest/assets/voltage.svg" "$ICON_DIR/voltage.svg"
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" &>/dev/null || true

  mkdir -p "$DESKTOP_DIR"
  local desktop_file="$DESKTOP_DIR/voltage-manager.desktop"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Version=1.0
Name=Voltage
Comment=Web App Manager (Voltage)
Exec=bash -c 'cd "$dest" && npm start'
Terminal=false
Type=Application
Icon=voltage
StartupWMClass=voltage
EOF
  update-desktop-database "$DESKTOP_DIR" &>/dev/null || true
  ok "Desktop entry created: $desktop_file"
}

# ── uninstall ─────────────────────────────────────────────────────────────────
uninstall() {
  local dest="$1"

  header "Removing voltage …"

  local desktop_file="$DESKTOP_DIR/voltage-manager.desktop"

  [ -f "$desktop_file" ] && { rm -f "$desktop_file"; ok "Desktop entry removed"; } \
                          || info "Desktop entry not found, skipping"
  for icon in voltage; do
    local f="$ICON_DIR/${icon}.svg"
    [ -f "$f" ] && { rm -f "$f"; ok "Icon removed: ${icon}.svg"; } || true
  done
  update-desktop-database "$DESKTOP_DIR" &>/dev/null || true
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" &>/dev/null || true

  if [ -d "$dest" ]; then
    echo ""
    read -rp "  Remove installation directory $dest? [y/N] " _answer
    if [[ "$_answer" =~ ^[yY]$ ]]; then
      rm -rf "$dest"
      ok "Installation directory removed"
    else
      info "Kept $dest"
    fi
  else
    info "Installation directory not found, skipping"
  fi

  local profile_dir="$HOME/.config/voltage"
  if [ -d "$profile_dir" ]; then
    echo ""
    read -rp "  Remove app profile data at $profile_dir? [y/N] " _answer
    if [[ "$_answer" =~ ^[yY]$ ]]; then
      rm -rf "$profile_dir"
      ok "Profile data removed"
    else
      info "Kept $profile_dir"
    fi
  fi

  echo -e "\n${GREEN}${BOLD}Done.${RESET} voltage has been uninstalled.\n"
}

# ── main ──────────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}voltage installer${RESET}"
echo    "  https://github.com/db0x/voltage"

MODE=install
DEST=""

for arg in "$@"; do
  case "$arg" in
    --uninstall|-u) MODE=uninstall ;;
    *)              DEST="$arg" ;;
  esac
done

DEST="${DEST:-$DEFAULT_DEST}"

if [ "$MODE" = uninstall ]; then
  uninstall "$DEST"
  exit 0
fi

detect_pm

header "Checking requirements …"
check_git
check_node
check_npm
check_optional

header "Installing voltage …"
install_or_update "$DEST"

header "Setting up launcher …"
install_desktop_entry "$DEST"

echo -e "\n${GREEN}${BOLD}Done.${RESET} Launch voltage from your application menu, or run:\n"
echo    "    cd \"$DEST\" && npm start"
echo
