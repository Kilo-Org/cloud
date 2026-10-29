import { normalizePackageIdentifier, type McpPackageEcosystem } from './mcp-identity';

export type LauncherParseResult =
  | {
      eligible: true;
      ecosystem: McpPackageEcosystem;
      identifier: string;
      versionHint: string | null;
    }
  | { eligible: false; reason: string };

const NPM_SPEC = /^(@[^/@:\s]+\/[^/@:\s]+|[^/@:\s]+)(?:@(.+))?$/;
const PYPI_SPEC =
  /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|>=|@)([0-9][^\s,;]*)|@latest)?$/;

const NPX_FLAGS = new Set(['-y', '--yes']);

function ineligible(reason: string): LauncherParseResult {
  return { eligible: false, reason };
}

function versionHint(version: string | undefined): string | null {
  return version !== undefined && /^[0-9]/.test(version) ? version : null;
}

function parseNpmSpec(spec: string): LauncherParseResult {
  const match = NPM_SPEC.exec(spec);
  if (!match) return ineligible('The package isn’t a plain npm package name.');
  const identifier = normalizePackageIdentifier('npm', match[1]);
  if (!identifier.ok) return ineligible(identifier.reason);
  return {
    eligible: true,
    ecosystem: 'npm',
    identifier: identifier.value,
    versionHint: versionHint(match[2]),
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
    versionHint: versionHint(match[2]),
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
