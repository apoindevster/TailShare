#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../transport"
mkdir -p ../public/transport .build
GOOS=js GOARCH=wasm go build -tags="$(cat build-tags.txt),ts_omit_exec,ts_omit_ssh,ts_omit_sftp" -trimpath -ldflags='-s -w' -o .build/tailcat.wasm .
gzip -n -9 -c .build/tailcat.wasm > .build/tailcat.wasm.gz
install -m 644 "$(go env GOROOT)/lib/wasm/wasm_exec.js" .build/wasm_exec.js
install -m 644 "$(go env GOROOT)/LICENSE" ../public/transport/LICENSE.go
node ../scripts/transport-assets.mjs
