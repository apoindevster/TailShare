#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../transport"
mkdir -p .build
version=$(go list -m -f '{{.Version}}' github.com/tailscale/tailcat)
GOBIN="$(pwd)/.build" go install -trimpath "github.com/tailscale/tailcat/cmd/tailcat@$version"
