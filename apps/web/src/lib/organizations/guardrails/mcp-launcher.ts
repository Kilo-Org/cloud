import { normalizePackageIdentifier, type McpPackageEcosystem } from './mcp-identity';
import { packageVersionSpecHint } from './package-version-hint';

export type LauncherParseResult =
  | {
      eligible: true;
      ecosystem: McpPackageEcosystem;
      identifier: string;
      versionSpecHint: string | null;
    }
  | { eligible: false; reason: string };

const NPM_SPEC = /^(@[^/@:\s]+\/[^/@:\s]+|[^/@:\s]+)(?:@(.+))?$/;
const NPM_VERSION_OR_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const PYPI_SPEC =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|>=|@)([0-9][^\s,;]*)|@latest)?$/;

const NPX_FLAGS = new Set(['-y', '--yes']);

function ineligible(reason: string): LauncherParseResult {
  return { eligible: false, reason };
}

const NPM_RELEASE = /^v*(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}$/;
const NPM_THREE_PART_RELEASE = /^v*(?:\d+|[xX*])\.(?:\d+|[xX*])\.(?:\d+|[xX*])$/;
const NPM_FULL_VERSION = /^v*\d+\.\d+\.\d+$/;
const NPM_RELEASE_TAIL =
  /^(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

// npm reads a release such as `1`, `1.2`, `x`, `1.x` or `1.x.0` as a range over versions and
// refuses to use one as a dist-tag name; only a full three-part version names one release. A
// wildcard anywhere else, as in `release.x`, leaves an ordinary tag, so the release has to be
// version-shaped here. semver takes a prerelease or build tail only after a full three-part
// release, so `1.2.x+build` is a range while `1.x+build` and `release.x+build` are tags.
function isNpmRange(suffix: string): boolean {
  const separator = suffix.search(/[-+]/);
  const release = separator === -1 ? suffix : suffix.slice(0, separator);
  if (!NPM_RELEASE.test(release)) return false;
  if (
    separator !== -1 &&
    !(NPM_THREE_PART_RELEASE.test(release) && NPM_RELEASE_TAIL.test(suffix.slice(separator)))
  ) {
    return false;
  }
  return /[xX*]/.test(release) || !NPM_FULL_VERSION.test(release);
}

function parseNpmSpec(spec: string): LauncherParseResult {
  const match = NPM_SPEC.exec(spec);
  if (!match) return ineligible('The package isn’t a plain npm package name.');
  const suffix = match[2];
  if (suffix !== undefined && (!NPM_VERSION_OR_TAG.test(suffix) || isNpmRange(suffix))) {
    return ineligible(
      'The package can only be pinned to one version or a dist-tag, such as 1.2.3 or latest.'
    );
  }
  const identifier = normalizePackageIdentifier('npm', match[1]);
  if (!identifier.ok) return ineligible(identifier.reason);
  return {
    eligible: true,
    ecosystem: 'npm',
    identifier: identifier.value,
    versionSpecHint: packageVersionSpecHint('npm', suffix),
  };
}

function parsePypiSpec(spec: string): LauncherParseResult {
  const match = PYPI_SPEC.exec(spec);
  if (!match) return ineligible('The package isn’t a plain PyPI package name.');
  const identifier = normalizePackageIdentifier('pypi', match[1]);
  if (!identifier.ok) return ineligible(identifier.reason);
  return {
    eligible: true,
    ecosystem: 'pypi',
    identifier: identifier.value,
    versionSpecHint: packageVersionSpecHint('pypi', match[2]),
  };
}

function firstPackageToken(
  args: string[],
  allowedFlags: ReadonlySet<string>
): { spec: string } | { reason: string } {
  for (const arg of args) {
    if (!arg.startsWith('-')) return { spec: arg };
    if (!allowedFlags.has(arg)) return { reason: `Uses the launcher option ${arg}.` };
  }
  return { reason: 'No package was specified.' };
}

function parseNodeRunner(args: string[], allowedFlags: ReadonlySet<string>): LauncherParseResult {
  const token = firstPackageToken(args, allowedFlags);
  return 'spec' in token ? parseNpmSpec(token.spec) : ineligible(token.reason);
}

function parseUvxRunner(args: string[]): LauncherParseResult {
  let fromSpec: string | null = null;
  let firstPositional: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--from') {
      fromSpec = args[index + 1] ?? null;
      index += 1;
      if (fromSpec === null) return ineligible('No package was specified.');
      break;
    }
    if (arg.startsWith('--from=')) {
      fromSpec = arg.slice('--from='.length);
      break;
    }
    if (arg.startsWith('-')) return ineligible(`Uses the launcher option ${arg}.`);
    firstPositional = arg;
    break;
  }
  const spec = fromSpec ?? firstPositional;
  return spec === null ? ineligible('No package was specified.') : parsePypiSpec(spec);
}

export function parseLauncherCommand(argv: string[]): LauncherParseResult {
  const [rawCommand, ...args] = argv;
  if (rawCommand === undefined || rawCommand === '') return ineligible('No command was specified.');
  if (/[\\/]/.test(rawCommand)) {
    return ineligible('Runs a program from a local path, which can’t be verified.');
  }
  const command = rawCommand.replace(/\.(cmd|exe)$/i, '').toLowerCase();
  switch (command) {
    case 'npx':
      return parseNodeRunner(args, NPX_FLAGS);
    case 'bunx':
      return parseNodeRunner(args, new Set());
    case 'pnpm':
      return args[0] === 'dlx'
        ? parseNodeRunner(args.slice(1), new Set())
        : ineligible('Runs a local program, which can’t be verified.');
    case 'uvx':
      return parseUvxRunner(args);
    case 'uv':
      return args[0] === 'tool' && args[1] === 'run'
        ? parseUvxRunner(args.slice(2))
        : ineligible('Runs a local program, which can’t be verified.');
    case 'docker':
    case 'podman':
      return ineligible('Container images aren’t supported yet.');
    default:
      return ineligible('Runs a local program, which can’t be verified.');
  }
}
