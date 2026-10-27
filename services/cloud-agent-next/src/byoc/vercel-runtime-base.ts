import { RUNTIME_BASE_ABI } from '../sandbox-control/runtime-release.js';
import { RUNTIME_DISTRIBUTION } from '../shared/runtime-distribution.js';

export const VERCEL_BASE_SYSTEM_SETUP =
  'set -euo pipefail; sudo dnf install -y git git-lfs jq tar gzip; sudo mkdir -p /workspace /usr/local/share/kilo /opt/git/etc; sudo chown "$(id -u):$(id -g)" /workspace; test -w /workspace; sudo git lfs install --system --skip-repo';

export const VERCEL_BASE_NODE_SETUP = `set -euo pipefail; node_path="$(node -p 'process.execPath')"; sudo ln -sf "$node_path" /usr/local/bin/node; test -x /usr/local/bin/node; curl -fsSL https://bun.sh/install | bash -s bun-v${RUNTIME_DISTRIBUTION.bun}; sudo install -m 0755 "$HOME/.bun/bin/bun" /usr/local/bin/bun`;

/** Downloaded releases replace CLI/control files; only base dependencies require a new snapshot. */
export async function vercelRuntimeBaseDigest(): Promise<string> {
  const input = JSON.stringify({
    format: 1,
    abi: RUNTIME_BASE_ABI,
    nodeMajor: RUNTIME_DISTRIBUTION.nodeMajor,
    systemSetup: VERCEL_BASE_SYSTEM_SETUP,
    bunSetup: VERCEL_BASE_NODE_SETUP,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `downloaded-base-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
