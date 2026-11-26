#!/usr/bin/env bash
# Jarvis one-line installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/EricTechPro/jarvis/main/get.sh | bash
#
# macOS: downloads the latest release's DMG for this Mac's chip, puts Jarvis.app in /Applications (or
# ~/Applications when /Applications isn't writable) and opens it. Files curl downloads carry no Gatekeeper
# quarantine flag, so the unsigned build opens without the "damaged" warning.
# Linux (beta, x86_64): puts the AppImage in ~/Applications, adds a menu entry and starts it.
#
# Options:
#   --version <tag>   install that release (for example v0.2.0) instead of the latest
#   --no-open         install only, don't start Jarvis
#   -h, --help        show this help
#
# Environment:
#   JARVIS_VERSION    same as --version
#   JARVIS_REPO       GitHub owner/repo to download from (default EricTechPro/jarvis)
#   JARVIS_URL        exact file URL to install instead (file:// works; used for testing)
#   JARVIS_APP_DIR    folder to install into (default /Applications on macOS, ~/Applications on Linux)
#
# Written for bash 3.2 (stock macOS). The whole script lives in main(), called on the last line, so a
# download cut off halfway through runs nothing.

set -euo pipefail

say()  { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$1" >&2; exit "${2:-1}"; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() { sed -n '2,21p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null | sed 's/^# \{0,1\}//' || true; }

# Release asset names. Keep in step with the "Attach to a draft release" step in .github/workflows/release.yml.
asset_for() {
  case "$1" in
    Darwin-arm64) echo "Jarvis-macos-arm64.dmg" ;;
    Darwin-x86_64) echo "Jarvis-macos-x64.dmg" ;;
    Linux-x86_64) echo "Jarvis-linux-x64.AppImage" ;;
    *) return 1 ;;
  esac
}

install_macos() {
  local file="$1" tmp="$2" open="$3" mnt app dest
  mnt="$tmp/mnt"
  mkdir -p "$mnt"
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$file" >/dev/null 2>&1 \
    || die "couldn't open the downloaded disk image."
  app=""
  for app in "$mnt"/*.app; do break; done
  if [ -z "$app" ] || [ ! -d "$app" ]; then
    hdiutil detach -quiet "$mnt" || true
    die "the disk image has no app inside."
  fi

  dest="${JARVIS_APP_DIR:-/Applications}"
  if [ -z "${JARVIS_APP_DIR:-}" ] && [ ! -w "$dest" ]; then
    dest="$HOME/Applications"
    mkdir -p "$dest"
    warn "/Applications isn't writable for this user, so Jarvis goes in $dest."
  fi

  # Quit a running copy first so the new one replaces it cleanly.
  osascript -e 'tell application id "com.erictech.jarvis" to quit' >/dev/null 2>&1 || true
  # The menu bar app keeps running after that quit, so the old version would stay in memory: end it (its helpers go
  # with it, they exit when it does), waiting up to 5 s.
  pkill -f '/Jarvis\.app/Contents/MacOS/jarvis$' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do pgrep -f '/Jarvis\.app/Contents/MacOS/jarvis$' >/dev/null 2>&1 || break; sleep 1; done

  say "-> installing to $dest/Jarvis.app"
  rm -rf "$dest/Jarvis.app"
  ditto "$app" "$dest/Jarvis.app" || { hdiutil detach -quiet "$mnt" || true; die "couldn't copy Jarvis.app to $dest."; }
  hdiutil detach -quiet "$mnt" || true
  # Belt and braces: curl sets no quarantine flag, but clear one if something else did.
  xattr -dr com.apple.quarantine "$dest/Jarvis.app" 2>/dev/null || true

  if [ "$open" -eq 1 ]; then open "$dest/Jarvis.app"; fi
  say "Jarvis is installed in $dest/Jarvis.app"
}

install_linux() {
  local file="$1" open="$2" dir bin apps
  dir="${JARVIS_APP_DIR:-$HOME/Applications}"
  mkdir -p "$dir"
  bin="$dir/Jarvis.AppImage"
  apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$apps"

  pkill -f "$bin" >/dev/null 2>&1 || true
  say "-> installing to $bin"
  cp "$file" "$bin.new"
  chmod +x "$bin.new"
  mv -f "$bin.new" "$bin"

  cat > "$apps/jarvis.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Jarvis
Comment=AI desktop companion
Exec="$bin" %U
Terminal=false
Categories=Utility;
EOF

  if ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    warn "AppImages need FUSE 2 (libfuse2 / fuse-libs). If Jarvis doesn't start, install it with your package manager."
  fi

  if [ "$open" -eq 1 ]; then
    if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
      nohup "$bin" >/dev/null 2>&1 &
    else
      say "No desktop session found, so Jarvis wasn't started. Start it from your app menu."
    fi
  fi
  say "Jarvis is installed in $bin"
}

main() {
  local version="${JARVIS_VERSION:-}" open=1
  local repo="${JARVIS_REPO:-EricTechPro/jarvis}"

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) [ $# -ge 2 ] || die "--version needs a release tag, for example v0.2.0" 64; version="$2"; shift 2 ;;
      --version=*) version="${1#--version=}"; shift ;;
      --no-open) open=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" 64 ;;
    esac
  done

  if [ "$(id -u)" -eq 0 ]; then
    die "please don't run this as root (or with sudo). Run it as your normal user."
  fi
  have curl || die "curl is missing. Install it and run this again." 69

  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$arch" in aarch64) arch="arm64" ;; amd64) arch="x86_64" ;; esac
  # A shell running under Rosetta reports x86_64 on Apple silicon; install the native build anyway.
  if [ "$os" = Darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then arch="arm64"; fi

  local name
  name="$(asset_for "$os-$arch")" || die "there's no Jarvis build for $os $arch yet. Builds exist for macOS (Apple silicon and Intel) and Linux x86_64; Windows uses get.ps1." 1
  if [ "$os" = Darwin ] && ! { have hdiutil && have ditto; }; then die "hdiutil and ditto are missing; is this really macOS?" 69; fi

  local url="${JARVIS_URL:-}"
  if [ -z "$url" ]; then
    if [ -n "$version" ]; then url="https://github.com/$repo/releases/download/$version/$name"
    else url="https://github.com/$repo/releases/latest/download/$name"
    fi
  fi

  local tmp
  tmp="$(mktemp -d 2>/dev/null || mktemp -d -t jarvis)"
  # shellcheck disable=SC2064
  trap "hdiutil detach -quiet '$tmp/mnt' >/dev/null 2>&1 || true; rm -rf '$tmp'" EXIT INT TERM

  say "Jarvis installer"
  say "-> downloading $url"
  curl -fL --progress-bar "$url" -o "$tmp/$name" \
    || die "download failed: $url. Check your internet connection, or that the release exists." 1

  if [ "$os" = Darwin ]; then install_macos "$tmp/$name" "$tmp" "$open"
  else install_linux "$tmp/$name" "$open"
  fi
}

main "$@"
