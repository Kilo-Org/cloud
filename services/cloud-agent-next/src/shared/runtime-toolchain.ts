import { shellQuote } from '../kilo/utils.js';
import { KILO_CLI_VERSION } from './kilo-cli-version.js';
import { RUNTIME_DISTRIBUTION } from './runtime-distribution.js';

/**
 * Base-image toolchain pins.
 *
 * Every third-party tool the Vercel base snapshot boots with is installed from a
 * pinned distribution whose SHA-256 is committed here, next to the versions in
 * `RUNTIME_DISTRIBUTION`: release archives for the standalone binaries and
 * registry tarballs for the npm packages. The generated scripts check the
 * downloaded bytes before they unpack or install anything, and check the
 * installed result again, so the snapshot content is a function of this file
 * rather than of what a distribution host serves at build time.
 *
 * Both snapshot producers use these builders: the operator script
 * (`scripts/vercel-snapshot.ts`) and the Durable Object build
 * (`src/persistence/VercelSnapshotBuild.ts`).
 *
 * Re-measuring a pin after a deliberate version bump means downloading the pinned
 * URL and running `sha256sum` on the archive and on the extracted `member`; for an
 * npm package, on the file its install script leaves at `<npm root -g>/<installedPath>`.
 */

type PinnedToolBase = {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  /** Every digest a correct install may have; one per published binary variant. */
  readonly installedSha256: readonly string[];
};

export type PinnedAgentTool = PinnedToolBase &
  (
    | {
        readonly kind: 'archive';
        readonly format: 'tar.gz' | 'zip';
        /** Path of the binary inside the archive. */
        readonly member: string;
        readonly installPath: string;
      }
    | {
        readonly kind: 'npm';
        /**
         * File the package's install script leaves behind, relative to the npm
         * global root. It is what actually runs, so a verified tarball whose
         * install script behaves differently still fails the build.
         */
        readonly installedPath: string;
      }
  );

export type ToolchainTool = 'bun' | 'rg' | 'gh' | 'glab' | 'pnpm' | 'kilo';

/** Each key is the command the tool installs, which is also its version-check command. */
export const RUNTIME_TOOLCHAIN = {
  // The x64 and x64-baseline archives publish the same binary; the baseline one is
  // pinned because it runs on every x64 host, which is what the previous installer
  // selected when AVX2 was absent.
  bun: {
    kind: 'archive',
    version: RUNTIME_DISTRIBUTION.bun,
    url: `https://github.com/oven-sh/bun/releases/download/bun-v${RUNTIME_DISTRIBUTION.bun}/bun-linux-x64-baseline.zip`,
    sha256: 'e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76',
    format: 'zip',
    member: 'bun-linux-x64-baseline/bun',
    installPath: '/usr/local/bin/bun',
    installedSha256: ['10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235'],
  },
  // AL2023 core dnf does not ship ripgrep; it is SPAL-only.
  rg: {
    kind: 'archive',
    version: '15.2.0',
    url: 'https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz',
    sha256: '33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c',
    format: 'tar.gz',
    member: 'ripgrep-15.2.0-x86_64-unknown-linux-musl/rg',
    installPath: '/usr/local/bin/rg',
    installedSha256: ['e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849'],
  },
  gh: {
    kind: 'archive',
    version: RUNTIME_DISTRIBUTION.gh,
    url: `https://github.com/cli/cli/releases/download/v${RUNTIME_DISTRIBUTION.gh}/gh_${RUNTIME_DISTRIBUTION.gh}_linux_amd64.tar.gz`,
    sha256: '4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d',
    format: 'tar.gz',
    member: `gh_${RUNTIME_DISTRIBUTION.gh}_linux_amd64/bin/gh`,
    installPath: '/usr/local/bin/gh',
    installedSha256: ['b768184570b12536be4ac1528893f6340d1c6a7b40b56ad45bca9cd0e87ad34d'],
  },
  // 1.82.0+ authenticates `GITLAB_TOKEN` OAuth tokens as `Authorization: Bearer`
  // instead of `PRIVATE-TOKEN`, which GitLab rejects for them.
  glab: {
    kind: 'archive',
    version: RUNTIME_DISTRIBUTION.glab,
    url: `https://gitlab.com/gitlab-org/cli/-/releases/v${RUNTIME_DISTRIBUTION.glab}/downloads/glab_${RUNTIME_DISTRIBUTION.glab}_linux_amd64.tar.gz`,
    sha256: '63df684842b0697e418649dd64374d37ac1da0fbcdcb422d6a5557222f8bb40f',
    format: 'tar.gz',
    member: 'bin/glab',
    installPath: '/usr/local/bin/glab',
    installedSha256: ['a2ee2ea59129e39a7f15cf2443085aef8d495d2425f3f8942b43a0ba1f8533a2'],
  },
  // Its install script places the native binary from the `@pnpm/exe.linux-x64`
  // dependency; it downloads nothing.
  pnpm: {
    kind: 'npm',
    version: RUNTIME_DISTRIBUTION.pnpm,
    url: `https://registry.npmjs.org/pnpm/-/pnpm-${RUNTIME_DISTRIBUTION.pnpm}.tgz`,
    sha256: 'ea206e35474bf87be9564a85ca70ed1c8ebdc45da55aafb0a3bf09d1ba69b179',
    installedPath: 'pnpm/pnpm',
    installedSha256: ['5e9119e6f4f18dace3795169e9b3672231ab3662505862dc3026571303a8ef32'],
  },
  // Its install script copies the platform binary to `bin/.kilo`; without it
  // `kilo` cannot start. The linux-x64 and linux-x64-baseline variants publish the
  // same bytes, so one digest covers the selection the script makes.
  kilo: {
    kind: 'npm',
    version: KILO_CLI_VERSION,
    url: `https://registry.npmjs.org/@kilocode/cli/-/cli-${KILO_CLI_VERSION}.tgz`,
    sha256: '6f5739bd5e61317743f6a42ccbf9735a4785e9bb1fa10fea7283eabffca7db40',
    installedPath: '@kilocode/cli/bin/.kilo',
    installedSha256: ['d252701f7cfdcffa77003670b2d127963a967fb25ebd09546685e1bd659edbfa'],
  },
} as const satisfies Record<ToolchainTool, PinnedAgentTool>;

export const TOOLCHAIN_TOOLS = Object.keys(RUNTIME_TOOLCHAIN) as ToolchainTool[];

/**
 * Shell helpers shared by every generated script: `check_sha256 <file> <digest>…`
 * fails the script with a message naming the file and the expected digests, and
 * `fetch_verified <url> <digest> <destination>` downloads over HTTPS and checks it.
 */
const SHA256_GUARD = [
  'check_sha256() {',
  '  file=$1',
  '  shift',
  '  actual=$(sha256sum "$file" | cut -d\' \' -f1)',
  '  for expected in "$@"; do',
  '    if [ "$actual" = "$expected" ]; then return 0; fi',
  '  done',
  '  echo "sha256 mismatch for $file: got $actual, expected $*" >&2',
  '  exit 1',
  '}',
  'fetch_verified() {',
  '  curl -fsSL --proto \'=https\' --proto-redir \'=https\' --tlsv1.2 --retry 3 --retry-delay 2 "$1" -o "$3"',
  '  check_sha256 "$3" "$2"',
  '}',
].join('\n');

/**
 * A self-contained block: it owns a temporary directory, removes it on exit, and
 * fails the caller under `set -e`, so blocks can be joined into one command.
 */
function scriptBlock(lines: readonly string[]): string {
  return [
    '(',
    'set -euo pipefail',
    'work=$(mktemp -d)',
    `trap 'rm -rf "$work"' EXIT`,
    ...lines,
    ')',
  ].join('\n');
}

function quotedDigests(tool: PinnedAgentTool): string {
  return tool.installedSha256.map(digest => shellQuote(digest)).join(' ');
}

/**
 * Downloads one pinned release archive, checks its digest, unpacks it, installs
 * the binary it carries into `/usr/local/bin`, and checks the installed bytes.
 */
export function installPinnedArchiveScript(tool: ToolchainTool): string {
  const pin = RUNTIME_TOOLCHAIN[tool];
  if (pin.kind !== 'archive') throw new Error(`${tool} is not installed from a release archive`);
  const archivePath = `"$work/${tool}.${pin.format}"`;
  return scriptBlock([
    SHA256_GUARD,
    `fetch_verified ${shellQuote(pin.url)} ${shellQuote(pin.sha256)} ${archivePath}`,
    'mkdir -p "$work/extract"',
    pin.format === 'zip'
      ? `unzip -q ${archivePath} -d "$work/extract"`
      : `tar -xzf ${archivePath} -C "$work/extract"`,
    `sudo install -m 0755 "$work/extract/${pin.member}" ${shellQuote(pin.installPath)}`,
    `check_sha256 ${shellQuote(pin.installPath)} ${quotedDigests(pin)}`,
  ]);
}

/**
 * Downloads one pinned npm tarball, checks its digest, installs it globally from
 * that file (its install scripts run, because both packages need them to place
 * their binary), and checks the bytes the install left behind.
 */
export function installPinnedNpmPackageScript(tool: ToolchainTool): string {
  const pin = RUNTIME_TOOLCHAIN[tool];
  if (pin.kind !== 'npm') throw new Error(`${tool} is not installed from an npm tarball`);
  return scriptBlock([
    SHA256_GUARD,
    `fetch_verified ${shellQuote(pin.url)} ${shellQuote(pin.sha256)} "$work/package.tgz"`,
    'sudo npm install -g --loglevel=error "$work/package.tgz"',
    'npm_root=$(sudo npm root -g)',
    `check_sha256 "$npm_root/${pin.installedPath}" ${quotedDigests(pin)}`,
  ]);
}

/**
 * Exact version and installed-binary digest checks for the requested tools. An npm
 * package is resolved through the npm global root, so the check follows the same
 * install the command does.
 */
export function toolchainVerificationScript(tools: readonly ToolchainTool[]): string {
  const lines = ['set -euo pipefail', SHA256_GUARD];
  if (tools.some(tool => RUNTIME_TOOLCHAIN[tool].kind === 'npm'))
    lines.push('npm_root=$(sudo npm root -g)');
  for (const tool of tools) {
    const pin = RUNTIME_TOOLCHAIN[tool];
    const path =
      pin.kind === 'archive' ? shellQuote(pin.installPath) : `"$npm_root/${pin.installedPath}"`;
    lines.push(
      `command -v ${tool} >/dev/null`,
      `test "$(${tool} --version | head -n1 | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+' | head -n1)" = ${shellQuote(pin.version)}`,
      `check_sha256 ${path} ${quotedDigests(pin)}`
    );
  }
  return lines.join('\n');
}
