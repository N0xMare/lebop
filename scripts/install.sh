#!/usr/bin/env bash
# lebop installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/N0xMare/lebop/main/scripts/install.sh | bash
#
# Env overrides:
#   LEBOP_VERSION=v0.0.4          # pin a specific tag (default: latest)
#   LEBOP_INSTALL_DIR=/usr/local/bin  # install location (default: $HOME/.local/bin if writable, else /usr/local/bin)
#   LEBOP_REPO=N0xMare/lebop      # source repo (default)

set -euo pipefail

REPO="${LEBOP_REPO:-N0xMare/lebop}"
VERSION="${LEBOP_VERSION:-latest}"

red()    { printf "\033[31m%s\033[0m" "$*"; }
green()  { printf "\033[32m%s\033[0m" "$*"; }
yellow() { printf "\033[33m%s\033[0m" "$*"; }
bold()   { printf "\033[1m%s\033[0m"  "$*"; }

die() { printf "%s %s\n" "$(red error:)" "$*" >&2; exit 1; }
info() { printf "%s %s\n" "$(green '==>')" "$*"; }
warn() { printf "%s %s\n" "$(yellow 'warn:')" "$*" >&2; }

# --- platform detection ----------------------------------------------------

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)      die "unsupported OS: $uname_s (lebop supports darwin, linux)" ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) die "unsupported architecture: $uname_m (lebop supports x64, arm64)" ;;
esac

asset="lebop-${os}-${arch}"

# --- resolve version + URLs -------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  info "resolving latest release of $REPO"
  # GitHub redirects /releases/latest to the tagged URL; capture the tag.
  if ! redirect="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest")"; then
    die "could not resolve latest release tag for $REPO"
  fi
  VERSION="${redirect##*/}"
  case "$VERSION" in
    v[0-9]*) ;;
    *) die "could not resolve latest release tag (got '$VERSION'). Is $REPO public and tagged?" ;;
  esac
fi

base="https://github.com/${REPO}/releases/download/${VERSION}"
binary_url="${base}/${asset}"
sums_url="${base}/SHA256SUMS"

info "lebop $(bold "$VERSION") for $(bold "${os}-${arch}")"

# --- download to temp -------------------------------------------------------

tmp="$(mktemp -d -t lebop-install.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT

info "downloading $asset"
if ! curl -fsSL --proto '=https' -o "$tmp/$asset" "$binary_url"; then
  die "download failed: $binary_url"
fi

info "downloading SHA256SUMS"
if ! curl -fsSL --proto '=https' -o "$tmp/SHA256SUMS" "$sums_url"; then
  die "SHA256SUMS download failed: $sums_url"
fi

# --- verify -----------------------------------------------------------------

info "verifying SHA256"
expected="$(
  awk -v asset="$asset" '
    $2 == asset { print $1; found = 1; exit }
    END { if (!found) exit 1 }
  ' "$tmp/SHA256SUMS" || true
)"
if [ -z "$expected" ]; then
  die "no SHA256 entry for $asset in SHA256SUMS"
fi

if command -v sha256sum >/dev/null 2>&1; then
  if ! actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"; then
    die "sha256sum failed while verifying $asset"
  fi
elif command -v shasum >/dev/null 2>&1; then
  if ! actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"; then
    die "shasum failed while verifying $asset"
  fi
else
  die "neither sha256sum nor shasum found; cannot verify"
fi

if [ "$expected" != "$actual" ]; then
  die "SHA256 mismatch for $asset (expected $expected, got $actual) — refusing to install"
fi

# --- pick install dir -------------------------------------------------------

if [ -n "${LEBOP_INSTALL_DIR:-}" ]; then
  install_dir="$LEBOP_INSTALL_DIR"
elif mkdir -p "${HOME}/.local/bin" 2>/dev/null && [ -w "${HOME}/.local/bin" ]; then
  install_dir="${HOME}/.local/bin"
else
  install_dir="/usr/local/bin"
fi

if ! mkdir -p "$install_dir" 2>/dev/null; then
  if [ -n "${LEBOP_INSTALL_DIR:-}" ]; then
    die "could not create install dir: $install_dir"
  fi
  warn "$install_dir could not be created without sudo; trying sudo (non-interactive)"
  if ! sudo -n mkdir -p "$install_dir" 2>/dev/null; then
    if [ -t 0 ]; then
      sudo mkdir -p "$install_dir"
    else
      die "$install_dir requires sudo but no tty for password prompt. Set LEBOP_INSTALL_DIR to a writable path (e.g. \$HOME/.local/bin)."
    fi
  fi
fi
target="${install_dir}/lebop"

# --- install ----------------------------------------------------------------

if [ -w "$install_dir" ]; then
  install -m 0755 "$tmp/$asset" "$target"
else
  warn "$install_dir is not writable; trying sudo (non-interactive)"
  if ! sudo -n install -m 0755 "$tmp/$asset" "$target" 2>/dev/null; then
    if [ -t 0 ]; then
      sudo install -m 0755 "$tmp/$asset" "$target"
    else
      die "$install_dir requires sudo but no tty for password prompt. Set LEBOP_INSTALL_DIR to a writable path (e.g. \$HOME/.local/bin)."
    fi
  fi
fi

info "installed $(bold "$target")"

# --- PATH hint --------------------------------------------------------------

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    warn "$install_dir is not on your PATH"
    printf '       add this to your shell profile:\n'
    printf '         %s\n' "export PATH=\"$install_dir:\$PATH\""
    ;;
esac

printf "\n%s lebop %s installed. Run %s to authenticate.\n" \
  "$(green '✓')" "$(bold "$VERSION")" "$(bold 'lebop auth login')"
