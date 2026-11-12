#!/usr/bin/env bash
# Optional language/font packs, isolated from the base/core TDS.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -d "$REPO_ROOT/engine-artifacts/texmf/tex/latex/memoir" ]; then
  echo "Run scripts/fetch-tds.sh before building resource packs" >&2
  exit 1
fi
mkdir -p "$REPO_ROOT/engine-artifacts/resource-packs"
for pack in portuguese multilingual; do
  packages=$(node -e 'console.log(require(process.argv[1])[process.argv[2]].join(" "))' "$REPO_ROOT/scripts/data/resource-packs.json" "$pack")
  docker run --rm -e PACK="$pack" -e PACKAGES="$packages" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" -v "$REPO_ROOT:/workspace" ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5 bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq -o APT::Update::Error-Mode=any
    mkdir -p /tmp/debs /tmp/extracted
    cd /tmp/debs
    # Versions are fixed in resource-packs.json; apt checks repository hashes.
    apt-get download $PACKAGES
    for deb in *.deb; do dpkg-deb -x "$deb" /tmp/extracted; done
    # Materialize links inside the extracted package root, including absolute
    # Debian font links. Missing optional links are not published as files.
    find /tmp/extracted -type l | while read -r link; do
      target=$(readlink -f "$link" || true)
      case "$target" in /tmp/extracted/*) ;; *) target=/tmp/extracted$target ;; esac
      if [ -f "$target" ]; then
        cp "$target" /tmp/font-link-bytes
        rm "$link"
        cp /tmp/font-link-bytes "$link"
      else
        rm "$link"
      fi
    done
    out=/workspace/engine-artifacts/resource-packs/$PACK
    rm -rf "$out"
    mkdir -p "$out"
    for tree in /tmp/extracted/usr/share/texlive/texmf-dist /tmp/extracted/usr/share/texmf; do
      if [ -d "$tree" ]; then cp -rL "$tree"/. "$out"/; fi
    done
    for kind in opentype truetype; do
      if [ -d /tmp/extracted/usr/share/fonts/$kind ]; then
        mkdir -p "$out/fonts/$kind"
        cp -rL /tmp/extracted/usr/share/fonts/$kind/. "$out/fonts/$kind/"
      fi
    done
    rm -rf "$out/doc" "$out/source" "$out/ls-R"
    # Unicode Xe/LuaLaTeX profile: explicit Noto fonts rather than legacy
    # CJK metric/VF trees, which need other engines and hundreds of MB.
    if [ "$PACK" = multilingual ]; then
      mkdir -p /tmp/legacy-fonts
      for kind in vf tfm type1 source afm; do
        [ ! -d "$out/fonts/$kind" ] || mv "$out/fonts/$kind" /tmp/legacy-fonts/
      done
      for kind in opentype truetype; do
        mkdir -p /tmp/legacy-fonts/$kind
        for fontdir in "$out/fonts/$kind"/*; do
          case "$(basename "$fontdir")" in noto|fonts-hosny-amiri) continue ;; esac
          mv "$fontdir" /tmp/legacy-fonts/$kind/
        done
      done
    fi
    mkdir -p "$out/licenses"
    for copyright in /tmp/extracted/usr/share/doc/*/copyright; do
      [ -f "$copyright" ] || continue
      cp "$copyright" "$out/licenses/$(basename "$(dirname "$copyright")").copyright"
    done
    printf "%s\n" "$PACKAGES" > "$out/PACKAGES.txt"
    chown -R "$HOST_UID:$HOST_GID" "$out"
  '
done

# abntex2 depends on these satellites outside the mobile core. Copy them
# from the same locked base TDS instead of requiring an unverified CDN.
for dependency in memoir textcase bookmark enumitem xpatch booktabs mparhack; do
  cp -r "$REPO_ROOT/engine-artifacts/texmf/tex/latex/$dependency" "$REPO_ROOT/engine-artifacts/resource-packs/portuguese/tex/latex/"
done
