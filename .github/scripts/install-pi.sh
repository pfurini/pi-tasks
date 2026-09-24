#!/usr/bin/env bash
# Installs Pi at one version: every @earendil-works/pi-* package in devDependencies, plus the
# typebox that pi-coding-agent at that version depends on. Pi hands its own typebox to
# extensions, so the types this repo compiles against must come from the same release.
#
# The version is never written here: `floor` reads it from peerDependencies, `latest` from
# the npm registry. package.json is the only place a Pi version is stated.
#
#   install-pi.sh floor            CI: the earliest Pi the peer range claims (not saved)
#   install-pi.sh latest           CI: the newest published Pi (not saved)
#   install-pi.sh X.Y.Z --save     move the devDependency pins, with exact versions
#
# A run without --save leaves package.json and package-lock.json untouched; `npm ci`
# restores the pinned install afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."

target="${1:-}"
mode="${2:---no-save}"
case "$target" in
  floor) version="$(node -p "require('./package.json').peerDependencies['@earendil-works/pi-coding-agent'].replace(/^>=/, '')")" ;;
  latest) version="$(npm view @earendil-works/pi-coding-agent version)" ;;
  "") echo "usage: $0 floor|latest|<version> [--save]" >&2; exit 2 ;;
  *) version="$target" ;;
esac
case "$mode" in
  --no-save) flags=(--no-save) ;;
  --save) flags=(--save-dev --save-exact) ;;
  *) echo "usage: $0 floor|latest|<version> [--save]" >&2; exit 2 ;;
esac

typebox="$(npm view "@earendil-works/pi-coding-agent@$version" dependencies.typebox)"
if [ -z "$typebox" ]; then
  echo "install-pi: @earendil-works/pi-coding-agent@$version not found, or it declares no typebox" >&2
  exit 1
fi
read -r -a packages <<< "$(node -p "
  Object.keys(require('./package.json').devDependencies)
    .filter(name => name.startsWith('@earendil-works/pi-'))
    .map(name => name + '@$version')
    .join(' ')
")"

echo "install-pi: ${packages[*]} typebox@$typebox"
npm install --no-audit --no-fund "${flags[@]}" "${packages[@]}" "typebox@$typebox"
