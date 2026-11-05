import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

import { findManifestPort, readManifest, type Manifest } from './manifest';

// A diagnostics front end for the mobile dev loop. The Expo agent CLI answers two questions this
// repository cannot otherwise answer from one command: which dev server and runtime a worktree is
// talking to, and what the app threw with a source-mapped frame. Everything else stays with the
// dev runner (`pnpm dev:start` owns Metro) and `agent-device` (real taps).
//
// The CLI trusts an explicit `--dev-server-url` without checking the project it serves, and its own
// discovery only scans 8081-8085, so a worktree on KILO_PORT_OFFSET is invisible to it. This module
// therefore resolves the port from the dev session's manifest and requires the dev server to name
// this worktree's project root before any runtime read.

const DEFAULT_PORT = 8081;
const DEFAULT_ERROR_WINDOW_MS = 4000;

export type DiagnosticsCommand = 'status' | 'errors';

export type DiagnosticsArgs = {
  command: DiagnosticsCommand;
  port: number | null;
  platform: 'android' | 'ios';
  durationMs: number;
  json: boolean;
};

export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type StatusReport = {
  devServer?: {
    url?: string | null;
    running?: boolean | null;
    ready?: boolean | null;
    appsConnected?: number | null;
    projectRootMatched?: boolean | null;
  } | null;
};

export class DiagnosticsError extends Error {}

/** A refusal: the command understood the request and declined it. */
export class RefusedError extends DiagnosticsError {}

export function parseArgs(argv: string[]): DiagnosticsArgs {
  const args: DiagnosticsArgs = {
    command: 'status',
    port: null,
    platform: 'android',
    durationMs: DEFAULT_ERROR_WINDOW_MS,
    json: false,
  };
  const rest = [...argv];
  const first = rest[0];
  if (first != null && !first.startsWith('-')) {
    if (first !== 'status' && first !== 'errors') {
      throw new DiagnosticsError(`Unknown command "${first}". Use "status" or "errors".`);
    }
    args.command = first;
    rest.shift();
  }
  const platforms: string[] = [];
  while (rest.length > 0) {
    const flag = rest.shift() as string;
    if (flag === '--json') {
      args.json = true;
    } else if (flag === '--port' || flag === '--duration') {
      const value = rest.shift();
      if (value == null || value.startsWith('-'))
        throw new DiagnosticsError(`${flag} needs a value`);
      if (flag === '--port') args.port = parsePort(value);
      else args.durationMs = parseDuration(value);
    } else if (flag === '--android' || flag === '--ios') {
      platforms.push(flag.slice(2));
    } else if (flag === '-h' || flag === '--help') {
      throw new DiagnosticsError(usage());
    } else {
      throw new DiagnosticsError(`Unknown option "${flag}".\n\n${usage()}`);
    }
  }
  if (platforms.length > 1) {
    throw new DiagnosticsError('Name one platform: --android or --ios.');
  }
  if (platforms.length === 1) args.platform = platforms[0] as 'android' | 'ios';
  return args;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DiagnosticsError(`"${value}" is not a port`);
  }
  return port;
}

export function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s)?$/.exec(value);
  if (!match) throw new DiagnosticsError(`"${value}" is not a duration in ms or s`);
  const amount = Number(match[1]);
  const ms = match[2] === 's' ? amount * 1000 : amount;
  if (ms <= 0) throw new DiagnosticsError('The duration must be positive');
  return ms;
}

export function usage(): string {
  return [
    'Usage: pnpm dev:mobile:diagnostics [status|errors] [options]',
    '',
    'status   which dev server and runtime this worktree talks to, and whether it is this project',
    'errors   what the connected app threw, with the project frames of each error',
    '',
    'Options',
    '  --port <number>       Dev server port, instead of this worktree dev session manifest',
    '  --android | --ios     Platform whose app to read (default: android)',
    '  --duration <ms|Ns>    How long "errors" listens (default: 4000ms)',
    '  --json                Print the CLI report unchanged, as JSON',
    '',
    'Exit codes: 0 answered, 1 the command itself was wrong, 2 refused',
    '(no dev session, or the dev server on that port serves another project)',
    '',
    'Never starts Metro or a build. The dev runner owns Metro; taps stay with agent-device.',
  ].join('\n');
}

/**
 * The port of this worktree's Metro: the dev session's manifest first, because it records the
 * offset the session actually took, then the service default.
 */
export function resolvePort(args: {
  manifest: Manifest | undefined;
  defaultPort: number | undefined;
  override: number | null;
}): number {
  if (args.override != null) return args.override;
  const port = findManifestPort(args.manifest, 'mobile') ?? args.defaultPort;
  if (port == null) {
    throw new RefusedError(
      'This worktree has no mobile dev session. Start the stack with "pnpm dev:start mobile", then run this command again.'
    );
  }
  return port;
}

export function devServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Refuse a dev server that is not this worktree's. `projectRootMatched` is null when `/status`
 * did not name a project root, which proves nothing, so it is refused as well.
 */
export function gateStatus(report: StatusReport): void {
  const devServer = report.devServer;
  if (devServer?.running !== true) {
    throw new RefusedError(
      `No dev server answered at ${devServer?.url ?? 'the resolved port'}. Start the stack with "pnpm dev:start mobile".`
    );
  }
  if (devServer.projectRootMatched !== true) {
    throw new RefusedError(
      `The dev server at ${devServer.url ?? 'the resolved port'} does not name this worktree's project root, so it serves another project. Refusing to read its runtime. Run "pnpm dev:status --json" to get this worktree's port, or start its stack with "pnpm dev:start mobile".`
    );
  }
}

export function sandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, EXPO_NO_TELEMETRY: '1' };
}

export function cliArgsFor(args: DiagnosticsArgs, url: string): string[] {
  if (args.command === 'status') return ['status', '--json', '--dev-server-url', url];
  return [
    'runtime:errors',
    '--json',
    '--dev-server-url',
    url,
    '--platform',
    args.platform,
    '--duration',
    `${args.durationMs}ms`,
  ];
}

export function parseCliJson(result: CliResult, what: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new DiagnosticsError(
      `${what} did not print JSON. Exit ${result.code}.\n${result.stderr.trim() || result.stdout.trim()}`
    );
  }
}

export function formatErrors(report: unknown): string[] {
  const payload = report as {
    count?: number;
    errors?: Array<{ message?: string; frames?: Array<{ file?: string; lineNumber?: number }> }>;
    runtimeReadable?: boolean | null;
    durationMs?: number;
  };
  const count = payload.count ?? 0;
  const lines = [
    count === 0
      ? `No runtime errors in ${payload.durationMs ?? 0}ms. An empty window is not a healthy app.`
      : `${count} runtime error(s) in ${payload.durationMs ?? 0}ms.`,
  ];
  for (const error of payload.errors ?? []) {
    const frames = (error.frames ?? []).filter(frame => frame.file?.startsWith('src/'));
    const where = frames.length > 0 ? ` (${frames[0].file}:${frames[0].lineNumber ?? 0})` : '';
    lines.push(`  ${String(error.message ?? '').split('\n')[0]}${where}`);
  }
  return lines;
}

export function formatStatus(report: unknown): string[] {
  const payload = report as StatusReport;
  const devServer = payload.devServer ?? {};
  return [
    `metro     ${devServer.url ?? 'unknown'}  ${
      devServer.ready ? 'bundler ready' : 'bundler not ready'
    }  ${devServer.appsConnected ?? 0} app(s) connected  project root verified`,
  ];
}

export function runDiagnostics(
  argv: string[],
  deps: {
    mobileProjectRoot: string;
    manifest?: Manifest | undefined;
    defaultPort?: number | undefined;
    runCli: (args: string[]) => CliResult;
    print: (line: string) => void;
  }
): number {
  const args = parseArgs(argv);
  const port = resolvePort({
    manifest: deps.manifest,
    defaultPort: deps.defaultPort,
    override: args.port,
  });
  const url = devServerUrl(port);

  const status = deps.runCli(['status', '--json', '--dev-server-url', url]);
  if (status.code !== 0) {
    throw new DiagnosticsError(
      `The Expo agent CLI could not read ${url} (exit ${status.code}).\n${status.stderr.trim() || status.stdout.trim()}`
    );
  }
  const statusReport = parseCliJson(status, 'status');
  gateStatus(statusReport as StatusReport);

  if (args.command === 'status') {
    if (args.json) {
      deps.print(JSON.stringify(statusReport, null, 2));
      return 0;
    }
    deps.print(`worktree  ${deps.mobileProjectRoot}`);
    for (const line of formatStatus(statusReport)) deps.print(line);
    return 0;
  }

  const errors = deps.runCli(cliArgsFor(args, url));
  if (errors.code !== 0) {
    throw new DiagnosticsError(
      `The Expo agent CLI could not read runtime errors from ${url} (exit ${errors.code}).\n${errors.stderr.trim() || errors.stdout.trim()}`
    );
  }
  const report = parseCliJson(errors, 'runtime:errors');
  if (args.json) {
    deps.print(JSON.stringify(report, null, 2));
    return 0;
  }
  deps.print(`metro     ${url}  project root verified`);
  for (const line of formatErrors(report)) deps.print(line);
  return 0;
}

function main(): void {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const cliBinary = path.join(repoRoot, 'node_modules', '.bin', 'expo-agent-cli');
  const mobileProjectRoot = path.join(repoRoot, 'apps', 'mobile');
  try {
    const code = runDiagnostics(process.argv.slice(2), {
      mobileProjectRoot,
      manifest: readManifest(repoRoot),
      defaultPort: DEFAULT_PORT,
      runCli: args => {
        try {
          const stdout = execFileSync(cliBinary, args, {
            encoding: 'utf8',
            cwd: mobileProjectRoot,
            env: sandboxEnv(),
            maxBuffer: 32 * 1024 * 1024,
            timeout: 180_000,
          });
          return { code: 0, stdout, stderr: '' };
        } catch (error) {
          const failure = error as {
            status?: number;
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          return {
            code: typeof failure.status === 'number' ? failure.status : 1,
            stdout: failure.stdout ?? '',
            stderr: failure.stderr ?? failure.message ?? '',
          };
        }
      },
      print: line => console.log(line),
    });
    process.exit(code);
  } catch (error) {
    if (error instanceof DiagnosticsError) {
      console.error(error.message);
      process.exit(error instanceof RefusedError ? 2 : 1);
    }
    throw error;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename);

if (isMain) {
  main();
}
