import { shellQuote } from '../kilo/utils.js';
import { RUNTIME_BASE_ABI } from '../sandbox-control/runtime-release.js';
import { GH_STACK_INSTALL_PATH, RUNTIME_DISTRIBUTION } from '../shared/runtime-distribution.js';
import {
  TOOLCHAIN_TOOLS,
  baseBinaryCheckScript,
  installPinnedArchiveScript,
  installPinnedNpmPackageScript,
  toolchainVerificationScript,
} from '../shared/runtime-toolchain.js';

export const VERCEL_BASE_SYSTEM_SETUP =
  'set -euo pipefail; sudo dnf install -y git git-lfs jq tar gzip unzip; sudo mkdir -p /workspace /artifacts /usr/local/share/kilo /opt/git/etc; sudo chown "$(id -u):$(id -g)" /workspace /artifacts; test -w /workspace; sudo git lfs install --system --skip-repo';

export const VERCEL_BASE_NODE_SETUP = `set -euo pipefail; node_path="$(node -p 'process.execPath')"; sudo ln -sf "$node_path" /usr/local/bin/node; test -x /usr/local/bin/node; ${installPinnedArchiveScript('bun')}`;

export const VERCEL_BASE_GH_STACK_VERIFICATION = `test "$(sha256sum ${shellQuote(GH_STACK_INSTALL_PATH)} | cut -d' ' -f1)" = ${shellQuote(RUNTIME_DISTRIBUTION.ghStackSha256)}`;

export const VERCEL_BASE_GH_STACK_SETUP = [
  'set -euo pipefail',
  `curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 3 --retry-delay 2 ${shellQuote(`https://github.com/github/gh-stack/releases/download/v${RUNTIME_DISTRIBUTION.ghStack}/linux-amd64`)} -o /tmp/gh-stack`,
  `echo ${shellQuote(`${RUNTIME_DISTRIBUTION.ghStackSha256}  /tmp/gh-stack`)} | sha256sum -c -`,
  `sudo install -D -m 0755 /tmp/gh-stack ${shellQuote(GH_STACK_INSTALL_PATH)}`,
  'rm -f /tmp/gh-stack',
  VERCEL_BASE_GH_STACK_VERIFICATION,
].join('\n');

/**
 * The tools a session needs from the base. The bootstrap gives Kilo only the
 * process `PATH`, so `npm`, `npx` and the global `pnpm` bin from the Node
 * runtime directory are linked into `/usr/local/bin`, unless they are there already.
 * `npm` is linked first, so `sudo npm` resolves where `sudo` resets `PATH`.
 */
export const VERCEL_BASE_TOOL_SETUP = [
  'set -euo pipefail',
  installPinnedArchiveScript('rg'),
  installPinnedArchiveScript('gh'),
  installPinnedArchiveScript('glab'),
  'link_base_tool() { if [ "$1" != "/usr/local/bin/$2" ]; then sudo ln -sf "$1" "/usr/local/bin/$2"; fi; test -x "/usr/local/bin/$2"; }',
  `node_bin="$(dirname "$(node -p 'process.execPath')")"`,
  'link_base_tool "$node_bin/npm" npm',
  'link_base_tool "$node_bin/npx" npx',
  installPinnedNpmPackageScript('pnpm'),
  'link_base_tool "$(sudo npm prefix -g)/bin/pnpm" pnpm',
].join('\n');

/** Proves a builder or a snapshot has the pinned toolchain and every base command. */
export const VERCEL_BASE_VERIFICATION = [
  toolchainVerificationScript(TOOLCHAIN_TOOLS),
  baseBinaryCheckScript(),
  'case "$(node --version)" in v24.*) ;; *) exit 1 ;; esac',
].join('\n');

/** Everything the builder runs after the system packages, in order. */
export const VERCEL_BASE_INSTALL_COMMAND = [
  VERCEL_BASE_NODE_SETUP,
  VERCEL_BASE_GH_STACK_SETUP,
  VERCEL_BASE_TOOL_SETUP,
  VERCEL_BASE_VERIFICATION,
].join('\n');

/** Downloaded releases replace CLI/control files; only base dependencies require a new snapshot. */
export async function vercelRuntimeBaseDigest(): Promise<string> {
  const input = JSON.stringify({
    format: 1,
    abi: RUNTIME_BASE_ABI,
    nodeMajor: RUNTIME_DISTRIBUTION.nodeMajor,
    systemSetup: VERCEL_BASE_SYSTEM_SETUP,
    bunSetup: VERCEL_BASE_NODE_SETUP,
    ghStackSetup: VERCEL_BASE_GH_STACK_SETUP,
    toolSetup: VERCEL_BASE_TOOL_SETUP,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return `downloaded-base-v1:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}
