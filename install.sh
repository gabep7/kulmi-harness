#!/bin/sh
set -eu

REPO="${KULMI_REPOSITORY:-gabep7/kulmi-harness}"
VERSION="${KULMI_INSTALL_VERSION:-latest}"
SOURCE_REF="${KULMI_SOURCE_REF:-main}"
RELEASE_URL="${KULMI_RELEASE_URL:-}"
RELEASE_CHECKSUM_URL="${KULMI_RELEASE_CHECKSUM_URL:-}"
INSTALL_DIR="${KULMI_INSTALL_DIR:-$HOME/.local/lib/kulmi}"
BIN_DIR="${KULMI_BIN_DIR:-$HOME/.local/bin}"
SOURCE_DIR="${KULMI_INSTALL_SOURCE:-}"
MODE="${KULMI_INSTALL_MODE:-}"

case "${1:-}" in
  --copy) MODE="copy" ;;
  --link) MODE="link" ;;
  --help|-h)
    printf '%s\n' "usage: ./install.sh [--link|--copy]" "" \
      "  --link  fast development install linked to this checkout" \
      "  --copy  clean self-contained production install"
    exit 0
    ;;
  "") ;;
  *) printf 'kulmi: unknown option %s\n' "$1" >&2; exit 1 ;;
esac

if [ -z "$SOURCE_DIR" ] && [ "${KULMI_INSTALL_REMOTE:-0}" != "1" ]; then
  script_dir="$(CDPATH= cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
  if [ -n "$script_dir" ] && [ -f "$script_dir/package.json" ]; then
    SOURCE_DIR="$script_dir"
  fi
fi

if [ -z "$MODE" ]; then
  if [ -n "$SOURCE_DIR" ]; then MODE="link"; else MODE="copy"; fi
fi

fail() {
  printf 'kulmi: %s\n' "$1" >&2
  exit 1
}

has_authenticated_gh() {
  command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1
}

download_url() {
  url="$1"
  destination="$2"
  partial="$destination.part"
  http_code="$(curl --fail --location --silent --show-error --output "$partial" --write-out '%{http_code}' "$url")" && {
    mv "$partial" "$destination"
    return 0
  }
  status=$?
  rm -f "$partial"
  [ "$http_code" = "404" ] && return 2
  return "$status"
}

download_github_asset() {
  asset="$1"
  destination="$2"
  if [ "$VERSION" = "latest" ]; then
    endpoint="repos/$REPO/releases/latest"
  else
    endpoint="repos/$REPO/releases/tags/$VERSION"
  fi
  if ! asset_id="$(gh api --hostname github.com "$endpoint" --jq ".assets[] | select(.name == \"$asset\") | .id" 2>"$work/gh-api-error")"; then
    error="$(cat "$work/gh-api-error")"
    printf '%s\n' "$error" >&2
    case "$error" in
      *"HTTP 404"*) return 2 ;;
      *) return 1 ;;
    esac
  fi
  [ -n "$asset_id" ] || return 2
  gh api --hostname github.com -H 'Accept: application/octet-stream' \
    "repos/$REPO/releases/assets/$asset_id" > "$destination.part" || {
    rm -f "$destination.part"
    return 1
  }
  mv "$destination.part" "$destination"
}

download_release_asset() {
  asset="$1"
  destination="$2"
  if [ -n "$RELEASE_URL" ]; then
    if [ "$asset" = "kulmi-node.tar.gz" ]; then
      asset_url="$RELEASE_URL"
    elif [ -n "$RELEASE_CHECKSUM_URL" ]; then
      asset_url="$RELEASE_CHECKSUM_URL"
    else
      case "$RELEASE_URL" in
        *\?*) asset_url="${RELEASE_URL%%\?*}.sha256?${RELEASE_URL#*\?}" ;;
        *) asset_url="$RELEASE_URL.sha256" ;;
      esac
    fi
    download_url "$asset_url" "$destination"
  elif has_authenticated_gh; then
    download_github_asset "$asset" "$destination"
  else
    download_url "$release_base_url/$asset" "$destination"
  fi
}

verify_release_checksum() {
  archive="$1"
  checksum="$2"
  IFS=' ' read -r expected ignored < "$checksum" || fail "release checksum is empty"
  [ "${#expected}" -eq 64 ] || fail "release checksum is malformed"
  case "$expected" in *[!0-9A-Fa-f]*) fail "release checksum is malformed" ;; esac
  expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$archive")"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$archive")"
  else
    fail "sha256sum or shasum is required to verify release integrity"
  fi
  actual="${actual%% *}"
  [ "$actual" = "$expected" ] || fail "release checksum mismatch"
}

download_source() {
  destination="$1"
  if has_authenticated_gh; then
    gh api --hostname github.com "repos/$REPO/tarball/$SOURCE_REF" > "$destination"
  else
    curl --fail --location --silent --show-error \
      "https://github.com/$REPO/archive/$SOURCE_REF.tar.gz" -o "$destination"
  fi
}

command -v node >/dev/null 2>&1 || fail "Node.js 22 or newer is required"
command -v npm >/dev/null 2>&1 || fail "npm is required"
command -v git >/dev/null 2>&1 || fail "git is required"

case "$(uname -s)" in
  Darwin) [ -x /usr/bin/sandbox-exec ] || fail "macOS sandbox-exec is required" ;;
  Linux)
    command -v bwrap >/dev/null 2>&1 || fail "bubblewrap is required on Linux; install the bubblewrap package"
    bwrap --die-with-parent --unshare-all --ro-bind / / -- /bin/true 2>/dev/null || \
      fail "bubblewrap cannot create the required namespaces; check Ubuntu AppArmor user-namespace policy"
    ;;
  *) fail "only macOS and Linux are supported" ;;
esac

major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 22 ] || fail "Node.js 22 or newer is required, found $(node --version)"

work="$(mktemp -d "${TMPDIR:-/tmp}/kulmi-install.XXXXXX")"
cleanup() {
  if [ "${KULMI_KEEP_INSTALL_TEMP:-0}" != "1" ]; then
    rm -rf "$work"
  fi
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

legacy_data_dir="$HOME/.local/share/kulmi"
if [ "$INSTALL_DIR" != "$legacy_data_dir" ]; then
  if [ -L "$legacy_data_dir" ] && [ -f "$legacy_data_dir/package.json" ]; then
    unlink "$legacy_data_dir"
    mkdir -p "$legacy_data_dir"
    printf 'Separated session data from the previous development link.\n'
  elif [ -d "$legacy_data_dir/dist" ] && [ -f "$legacy_data_dir/package.json" ]; then
    mkdir -p "$work/legacy-data"
    if [ -d "$legacy_data_dir/sessions" ]; then
      mv "$legacy_data_dir/sessions" "$work/legacy-data/sessions"
    fi
    mv "$legacy_data_dir" "$work/legacy-app"
    mkdir -p "$legacy_data_dir"
    if [ -d "$work/legacy-data/sessions" ]; then
      mv "$work/legacy-data/sessions" "$legacy_data_dir/sessions"
    fi
    printf 'Migrated sessions from the previous installation layout.\n'
  fi
fi

if [ "$MODE" = "link" ]; then
  [ -n "$SOURCE_DIR" ] || fail "--link requires KULMI_INSTALL_SOURCE or a local checkout"
  [ -f "$SOURCE_DIR/package.json" ] || fail "KULMI_INSTALL_SOURCE is not a Kulmi checkout"
  SOURCE_DIR="$(CDPATH= cd "$SOURCE_DIR" && pwd)"
  [ "$SOURCE_DIR" != "$INSTALL_DIR" ] || fail "source and install directories must differ"

  if [ ! -x "$SOURCE_DIR/node_modules/.bin/tsc" ] || [ "$SOURCE_DIR/package-lock.json" -nt "$SOURCE_DIR/node_modules/.package-lock.json" ]; then
    printf 'Installing dependencies once...\n'
    (cd "$SOURCE_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
  fi

  source_fingerprint="$(cd "$SOURCE_DIR" && node scripts/source-fingerprint.mjs)"
  built_fingerprint="$(cat "$SOURCE_DIR/dist/.source-fingerprint" 2>/dev/null || true)"
  needs_build=0
  [ -f "$SOURCE_DIR/dist/cli.js" ] || needs_build=1
  [ "$source_fingerprint" = "$built_fingerprint" ] || needs_build=1
  if [ "$needs_build" -eq 1 ]; then
    printf 'Building changed sources...\n'
    (cd "$SOURCE_DIR" && npm run build)
  fi

  chmod +x "$SOURCE_DIR/dist/cli.js"
  candidate="$work/linked"
  ln -s "$SOURCE_DIR" "$candidate"
  install_kind="linked"
else
  package="$work/package"
  mkdir -p "$package"
  prebuilt=0
  if [ -n "$SOURCE_DIR" ]; then
    [ -f "$SOURCE_DIR/package.json" ] || fail "KULMI_INSTALL_SOURCE is not a Kulmi checkout"
    (cd "$SOURCE_DIR" && tar --exclude='./node_modules' --exclude='./dist' --exclude='./.git' -cf - .) | (cd "$package" && tar -xf -)
  else
    if [ -n "$RELEASE_URL" ] || ! has_authenticated_gh; then
      command -v curl >/dev/null 2>&1 || fail "curl is required when authenticated GitHub CLI access is unavailable"
    fi
    command -v tar >/dev/null 2>&1 || fail "tar is required"
    if [ "$VERSION" = "latest" ]; then
      release_base_url="https://github.com/$REPO/releases/latest/download"
    else
      release_base_url="https://github.com/$REPO/releases/download/$VERSION"
    fi
    printf 'Downloading prebuilt kulmi %s...\n' "$VERSION"
    if download_release_asset kulmi-node.tar.gz "$work/kulmi-node.tar.gz"; then
      if download_release_asset kulmi-node.tar.gz.sha256 "$work/kulmi-node.tar.gz.sha256"; then
        verify_release_checksum "$work/kulmi-node.tar.gz" "$work/kulmi-node.tar.gz.sha256"
      else
        checksum_status=$?
        if [ "$checksum_status" -eq 2 ]; then
          fail "release checksum is missing"
        fi
        fail "could not download release checksum"
      fi
      tar -xzf "$work/kulmi-node.tar.gz" -C "$package"
      [ -f "$package/dist/cli.js" ] || fail "release bundle is missing dist/cli.js"
      [ -d "$package/node_modules" ] || fail "release bundle is missing production dependencies"
      prebuilt=1
    else
      release_status=$?
      [ "$release_status" -eq 2 ] || fail "could not download prebuilt release"
      printf 'No prebuilt release found; falling back to source %s...\n' "$SOURCE_REF"
      download_source "$work/kulmi-source.tar.gz"
      tar -xzf "$work/kulmi-source.tar.gz" --strip-components=1 -C "$package"
    fi
  fi
  if [ "$prebuilt" -eq 0 ]; then
    printf 'Building a self-contained installation...\n'
    (cd "$package" && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund)
  fi
  chmod +x "$package/dist/cli.js"
  candidate="$package"
  install_kind="installed"
fi

backup=""
if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
  if [ "$MODE" = "link" ] && [ -L "$INSTALL_DIR" ] && [ "$(readlink "$INSTALL_DIR")" = "$SOURCE_DIR" ]; then
    candidate=""
  else
    backup="$work/previous"
    mv "$INSTALL_DIR" "$backup"
  fi
fi

if [ -n "$candidate" ] && ! mv "$candidate" "$INSTALL_DIR"; then
  [ -z "$backup" ] || mv "$backup" "$INSTALL_DIR"
  fail "could not install to $INSTALL_DIR"
fi

ln -sfn "$INSTALL_DIR/dist/cli.js" "$BIN_DIR/kulmi"

path_line='export PATH="$HOME/.local/bin:$PATH"'
path_updated=0
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    if [ "${KULMI_NO_PATH_UPDATE:-0}" != "1" ]; then
      case "${SHELL:-}" in
        */zsh) profile="$HOME/.zshrc" ;;
        */bash) profile="$HOME/.bashrc" ;;
        *) profile="$HOME/.profile" ;;
      esac
      touch "$profile"
      if ! grep -F "$path_line" "$profile" >/dev/null 2>&1; then
        printf '\n# Kulmi\n%s\n' "$path_line" >> "$profile"
      fi
      path_updated=1
    fi
    ;;
esac

printf 'Kulmi %s in %s\n' "$install_kind" "$INSTALL_DIR"
printf 'Run: kulmi\n'
if [ "$path_updated" -eq 1 ]; then
  printf 'Open a new terminal first, or run: export PATH="$HOME/.local/bin:$PATH"\n'
fi
printf 'Then run `kulmi init` and define a model profile with base_url and api_key_env.\n'
