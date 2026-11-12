#!/usr/bin/env bash
# Build Rust bindings using the CLI version pinned by Cargo.lock.
set -euo pipefail
cd "$(dirname "$0")"
PROFILE="${PROFILE:-release}"
OUT_DIR="${OUT_DIR:-pkg}"
want="$(awk '/^name = "wasm-bindgen"$/{getline; print $3}' Cargo.lock | tr -d '"')"
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "error: install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
actual="$(wasm-bindgen --version | awk '{print $2}')"
if [ "$actual" != "$want" ]; then
  echo "error: wasm-bindgen CLI $actual does not match Cargo.lock ($want)." >&2
  exit 1
fi
rustup target add wasm32-unknown-unknown >/dev/null 2>&1
if [ "$PROFILE" = debug ]; then PROFILE=dev; fi
cargo build --locked --profile "$PROFILE" --target wasm32-unknown-unknown --features wasm
ARTIFACT_PROFILE="$PROFILE"
if [ "$PROFILE" = dev ]; then ARTIFACT_PROFILE=debug; fi
WASM="target/wasm32-unknown-unknown/${ARTIFACT_PROFILE}/texlive_wasm.wasm"
wasm-bindgen "$WASM" --out-dir "$OUT_DIR" --target web --typescript
echo "wrote bindings to ${OUT_DIR}/ ($(du -h "$WASM" | cut -f1) core)"
