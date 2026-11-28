#!/bin/bash
# The relay host's startup script (instance metadata `startup-script`; README, "Deploy").
#
# Runs as root on every boot of the Debian 12 VM and is safe to run again: it installs Caddy from
# Debian, Node from nodejs.org at a pinned version checked against a pinned SHA-256, and starts
# the relay once its files are in place. It reads no secret; the host holds none.
set -euo pipefail

# Same release as the repository's .nvmrc; move both together.
NODE_VERSION=24.22.1
NODE_SHA256=6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6
NODE_TARBALL="node-v${NODE_VERSION}-linux-x64.tar.xz"

export DEBIAN_FRONTEND=noninteractive

if ! dpkg -s caddy unattended-upgrades > /dev/null 2>&1; then
  apt-get update
  apt-get install -y --no-install-recommends caddy unattended-upgrades ca-certificates curl xz-utils
fi

if [ "$(/opt/node/bin/node --version 2> /dev/null || true)" != "v${NODE_VERSION}" ]; then
  workdir=$(mktemp -d)
  curl -fsSL --proto '=https' -o "${workdir}/${NODE_TARBALL}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
  echo "${NODE_SHA256}  ${workdir}/${NODE_TARBALL}" | sha256sum --check --strict -
  rm -rf /opt/node
  mkdir -p /opt/node
  tar -xJf "${workdir}/${NODE_TARBALL}" --strip-components=1 --no-same-owner -C /opt/node
  rm -rf "${workdir}"
fi

mkdir -p /opt/github-relay
systemctl enable --now caddy

# The first boot has no relay files yet; the deploy step copies them and starts the unit.
if [ -f /etc/systemd/system/github-relay.service ] && [ -f /opt/github-relay/server.mjs ]; then
  systemctl enable --now github-relay
fi
