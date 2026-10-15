#!/usr/bin/env bun
/**
 * Process integration harness for the serialized runtime installer (execution
 * plan §9 "Process integration failure matrix").
 *
 * It runs the *actual* serialized launch command from `runtime-bootstrap.ts`
 * against a local HTTP artifact origin and real gzip/tar bytes, with a fake
 * supervisor and CLI, in a temporary reserved root. It observes effects: exit
 * codes, whether any runtime executed, whether the grant is absent from the CLI
 * probe, supervisor and their descendants, and the resulting alias/release layout.
 *
 * This is a local/CI harness. It is also imported by `test/e2e/runtime-upgrade.ts`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  RUNTIME_ALIAS_DIR_ENV,
  RUNTIME_ALLOW_INSECURE_ORIGIN_ENV,
  RUNTIME_ARTIFACT_GRANT_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_CLI_PATH_ENV,
  RUNTIME_DEADLINE_MS_ENV,
  RUNTIME_DESCRIPTOR_ENV,
  runtimeLaunchCommand,
} from '../src/sandbox-control/runtime-bootstrap.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_BASE_BUN_VERSION,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  runtimeArtifactHttpPathPattern,
  type RuntimeReleaseDescriptor,
} from '../src/shared/runtime-release.js';
import {
  parseRuntimeLaunchReceipt,
  runtimeLaunchReceiptPath,
  RUNTIME_INSTALLER_EXIT,
  RUNTIME_LAUNCH_RECEIPT_DIR_NAME,
  type RuntimeLaunchReceipt,
} from '../src/sandbox-control/runtime-launch-receipt.js';
import { packageRuntimeRelease, writeTarEntries } from './publish-runtime.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const FIXTURE_IMAGE = 'kilo-runtime-base-fixture:test';
const FIXTURE_CONTEXT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'test/fixtures/runtime-base'
);

/**
 * Build the pinned Linux fixture image once. It is built for `linux/amd64` so the
 * published x64-only CLI packages run under emulation on other host architectures.
 */
let fixtureImageReady = false;
export function ensureFixtureImage(): void {
  if (fixtureImageReady) return;
  const build = spawnSync(
    'docker',
    [
      'build',
      '--platform',
      'linux/amd64',
      '--build-arg',
      `BUN_VERSION=${RUNTIME_BASE_BUN_VERSION}`,
      '-t',
      FIXTURE_IMAGE,
      FIXTURE_CONTEXT,
    ],
    {
      stdio: 'inherit',
    }
  );
  if (build.status !== 0) throw new Error('failed to build the runtime fixture image');
  fixtureImageReady = true;
}

const BOOTSTRAP_ENTRY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/sandbox-control/runtime-bootstrap.ts'
);

let bundledCommandCache: string | null = null;

/**
 * Bundle `runtime-bootstrap.ts` the way Wrangler does (`keepNames: true`,
 * `minify: true`) and return the bundled launch command. This catches source that
 * only runs when helpers are renamed or wrapped at bundle time.
 */
export async function bundleLaunchCommand(): Promise<string> {
  if (bundledCommandCache !== null) return bundledCommandCache;
  const requireFromSelf = createRequire(import.meta.url);
  const requireFromWrangler = createRequire(requireFromSelf.resolve('wrangler/package.json'));
  const esbuildModule = (await import(
    pathToFileURL(requireFromWrangler.resolve('esbuild')).href
  )) as { default: { build: (options: Record<string, unknown>) => Promise<unknown> } };
  const esbuild = esbuildModule.default;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-bundle-'));
  const outfile = path.join(dir, 'bootstrap.mjs');
  await esbuild.build({
    entryPoints: [BOOTSTRAP_ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    keepNames: true,
    minify: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'ts-from-js',
        setup(build: {
          onResolve: (
            options: { filter: RegExp },
            callback: (args: { path: string; importer: string }) => { path: string } | undefined
          ) => void;
        }) {
          build.onResolve({ filter: /\.js$/ }, args => {
            if (!args.importer || !args.path.startsWith('.')) return undefined;
            const candidate = path.resolve(
              path.dirname(args.importer),
              args.path.replace(/\.js$/, '.ts')
            );
            return fsSync.existsSync(candidate) ? { path: candidate } : undefined;
          });
        },
      },
    ],
  });
  const bundled = (await import(pathToFileURL(outfile).href)) as {
    runtimeLaunchCommand: () => string;
  };
  bundledCommandCache = bundled.runtimeLaunchCommand();
  await fs.rm(dir, { recursive: true, force: true });
  return bundledCommandCache;
}

export type ArtifactObject = { sha256: string; bytes: Uint8Array };

export type ArtifactOrigin = {
  origin: string;
  requests: string[];
  close: () => void;
};

export type OriginOptions = {
  rejectGrant?: boolean;
  missing?: boolean;
  /** Reject the first N authorized requests, then succeed. */
  failuresBeforeSuccess?: number;
  /** Redirect every authorized request. */
  redirect?: boolean;
  /** Delay each response by this many milliseconds (for deadline tests). */
  stallMs?: number;
};

export async function serveArtifacts(
  objects: readonly ArtifactObject[],
  grant: string,
  options: OriginOptions = {}
): Promise<ArtifactOrigin> {
  const requests: string[] = [];
  const bySha = new Map(objects.map(object => [object.sha256, object.bytes]));
  let remainingFailures = options.failuresBeforeSuccess ?? 0;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    const match = runtimeArtifactHttpPathPattern().exec(url.pathname);
    if (!match) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    if (options.rejectGrant || request.headers.authorization !== `Bearer ${grant}`) {
      response.writeHead(401);
      response.end('unauthorized');
      return;
    }
    if (options.redirect) {
      response.writeHead(302, { Location: '/other' });
      response.end();
      return;
    }
    if (remainingFailures > 0) {
      remainingFailures -= 1;
      response.writeHead(500);
      response.end('transient');
      return;
    }
    const bytes = options.missing ? undefined : bySha.get(match[1]);
    const send = () => {
      if (!bytes) {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'Content-Length': String(bytes.byteLength) });
      response.end(Buffer.from(bytes));
    };
    if (options.stallMs) setTimeout(send, options.stallMs);
    else send();
  });
  // Bind all interfaces so a Linux fixture container reaches it via host.docker.internal.
  await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { origin: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}

export type InstallerRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  reservedRoot: string;
  aliasDir: string;
  supervisorRan: boolean;
  supervisorEnv: string | null;
  descendantsEnv: string | null;
  cliProbeEnv: string | null;
  /** The launch id embedded in the command, when the harness built it. */
  launchId: string | null;
  /** The parsed launch receipt, or null when it is missing or unreadable. */
  launchReceipt: RuntimeLaunchReceipt | null;
  /** Why the receipt did not parse as this launch, or null. */
  launchReceiptError: string | null;
};

export type InstallerCase = {
  name: string;
  descriptor: RuntimeReleaseDescriptor;
  objects: ArtifactObject[];
  seed?: (roots: { reservedRoot: string; aliasDir: string; markerDir: string }) => Promise<void>;
  origin?: OriginOptions;
  deadlineMs?: number;
  expectedExit: number;
  expectSupervisorRun: boolean;
  /** Reuse a caller-owned reserved root across runs (retention tests). */
  roots?: { reservedRoot: string; aliasDir: string; markerDir: string };
  /** Override the launch command (bundler regression uses a bundled command). */
  command?: string;
  /** Explicit launch id; a random one is generated when it is absent. */
  launchId?: string;
  /** Absolute creation deadline, measured forward from command build time. */
  deadlineInMs?: number;
  /** Extra assertions against the resulting layout. */
  assert?: (run: InstallerRun) => void;
};

export type InstallerCaseResult = {
  name: string;
  passed: boolean;
  exitCode: number;
  detail: string;
};

const CLI_MARKER = 'cli-probe-env.txt';
const SUPERVISOR_MARKER = 'supervisor-env.txt';
const MARKER_DIR_ENV = 'KILO_RUNTIME_MARKER_DIR';

function fakeCliScript(probeSleepSeconds = 0, probeExitCode?: number): string {
  return [
    '#!/bin/sh',
    `printf '%s' "$(env)" > "$KILO_RUNTIME_MARKER_DIR/${CLI_MARKER}"`,
    ...(probeSleepSeconds > 0 ? [`sleep ${probeSleepSeconds}`] : []),
    ...(probeExitCode === undefined ? ['echo 7.8.1'] : [`exit ${probeExitCode}`]),
  ].join('\n');
}

function fakeSupervisorScript(exitCode = 0): string {
  return [
    '#!/bin/sh',
    `printf '%s' "$(env)" > "$KILO_RUNTIME_MARKER_DIR/${SUPERVISOR_MARKER}"`,
    `sh -c 'env' > "$KILO_RUNTIME_MARKER_DIR/${SUPERVISOR_MARKER}.descendants"`,
    `exit ${exitCode}`,
  ].join('\n');
}

type FixtureVariants = {
  supervisorExitCode?: number;
  cliProbeSleepSeconds?: number;
  cliProbeExitCode?: number;
  omitSupervisor?: boolean;
};

function fixtureAssets(
  controlTag = '',
  extraControl?: { path: string; bytes: Uint8Array },
  variants: FixtureVariants = {}
): { cliEntries: TarEntry[]; controlEntries: TarEntry[] } {
  const encoder = new TextEncoder();
  const cliEntries = [
    {
      path: 'package/bin/kilo',
      mode: 0o100755,
      bytes: encoder.encode(
        fakeCliScript(variants.cliProbeSleepSeconds, variants.cliProbeExitCode)
      ),
    },
    { path: 'package/lib/asset-a.js', mode: 0o100644, bytes: encoder.encode('asset-a\n') },
    { path: 'package/lib/asset-b.js', mode: 0o100644, bytes: encoder.encode('asset-b\n') },
  ];
  const controlEntries = [
    ...(variants.omitSupervisor
      ? []
      : [
          {
            path: 'usr/local/bin/kilocode-control-plane-supervisor.sh',
            mode: 0o100755,
            bytes: encoder.encode(fakeSupervisorScript(variants.supervisorExitCode)),
          },
        ]),
    {
      path: 'usr/local/bin/kilocode-control-plane-wrapper.js',
      mode: 0o100644,
      bytes: encoder.encode(`wrapper bundle ${controlTag}\n`),
    },
    {
      path: 'opt/kilo-cloud/kilo-git-credential',
      mode: 0o100755,
      bytes: encoder.encode('#!/bin/sh\nexit 0\n'),
    },
    ...(extraControl
      ? [{ path: extraControl.path, mode: 0o100755, bytes: extraControl.bytes }]
      : []),
  ];
  return { cliEntries, controlEntries };
}

type TarEntry = { path: string; mode: number; bytes: Uint8Array };

export function detectHostPlatform(): RuntimeReleaseDescriptor['platform'] {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let libc: 'glibc' | 'musl' = 'musl';
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (report.header && typeof report.header.glibcVersionRuntime === 'string') libc = 'glibc';
    else
      libc = ['/lib/x86_64-linux-gnu/libc.so.6', '/lib/aarch64-linux-gnu/libc.so.6'].some(p =>
        fsSync.existsSync(p)
      )
        ? 'glibc'
        : 'musl';
  } catch {
    libc = 'musl';
  }
  let cpu: 'baseline' | 'modern' = 'baseline';
  try {
    const info = fsSync.readFileSync('/proc/cpuinfo', 'utf8');
    if (/(^|\s)avx2(\s|$)/.test(info.replace(/:/g, ' '))) cpu = 'modern';
  } catch {
    cpu = 'baseline';
  }
  return { os: 'linux', arch, libc, cpu };
}

/**
 * The platform the installer actually sees. On a non-Linux host the serialized
 * command runs inside the pinned Linux fixture image, so the descriptor must
 * describe that container, not the host.
 */
let fixturePlatformCache: RuntimeReleaseDescriptor['platform'] | null = null;
export function fixturePlatform(): RuntimeReleaseDescriptor['platform'] {
  if (fixturePlatformCache) return fixturePlatformCache;
  if (process.platform === 'linux') {
    fixturePlatformCache = detectHostPlatform();
    return fixturePlatformCache;
  }
  ensureFixtureImage();
  const machine = spawnSync('docker', ['run', '--rm', FIXTURE_IMAGE, 'uname', '-m'])
    .stdout.toString()
    .trim();
  const arch = machine === 'aarch64' ? 'arm64' : 'x64';
  const libcOutput = spawnSync('docker', [
    'run',
    '--rm',
    FIXTURE_IMAGE,
    'sh',
    '-c',
    'if [ -e /lib/x86_64-linux-gnu/libc.so.6 ] || [ -e /lib/aarch64-linux-gnu/libc.so.6 ] || [ -e /lib64/libc.so.6 ]; then echo glibc; else echo musl; fi',
  ])
    .stdout.toString()
    .trim();
  fixturePlatformCache = {
    os: 'linux',
    arch,
    libc: libcOutput === 'glibc' ? 'glibc' : 'musl',
    cpu: 'baseline',
  };
  return fixturePlatformCache;
}

export async function buildFixtureRelease(
  controlTag = '',
  extraControl?: { path: string; bytes: Uint8Array },
  variants: FixtureVariants = {}
) {
  const { cliEntries, controlEntries } = fixtureAssets(controlTag, extraControl, variants);
  const cliTarball = gzipSync(writeTarEntries(cliEntries));
  return packageRuntimeRelease({
    cliTarball,
    cliVersion: '7.8.1',
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: 'control-plane-v1',
    abi: RUNTIME_BASE_ABI,
    platform: fixturePlatform(),
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries,
  });
}

/** Raw ustar builder that can emit non-regular entry types and duplicates. */
export function buildRawTar(
  entries: readonly { path: string; type: number; mode: number; data: Uint8Array }[]
): Uint8Array {
  const blocks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const octal = (value: number, length: number) =>
      value
        .toString(8)
        .padStart(length - 1, '0')
        .slice(0, length - 1) + '\0';
    header.set(encoder.encode(entry.path).subarray(0, 100), 0);
    header.set(encoder.encode(octal(entry.mode, 8)), 100);
    header.set(encoder.encode(octal(0, 8)), 108);
    header.set(encoder.encode(octal(0, 8)), 116);
    header.set(encoder.encode(octal(entry.data.byteLength, 12)), 124);
    header.set(encoder.encode(octal(0, 12)), 136);
    for (let index = 148; index < 156; index += 1) header[index] = 0x20;
    header[156] = entry.type;
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(octal(checksum, 8)), 148);
    blocks.push(header);
    const data = new Uint8Array(Math.ceil(entry.data.byteLength / 512) * 512);
    data.set(entry.data);
    blocks.push(data);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return tar;
}

export async function runInstallerCase(testCase: InstallerCase): Promise<InstallerCaseResult> {
  const owned = testCase.roots === undefined;
  const root = owned ? await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-installer-')) : '';
  const reservedRoot = testCase.roots?.reservedRoot ?? path.join(root, 'reserved');
  const aliasDir = testCase.roots?.aliasDir ?? path.join(root, 'alias');
  const markerDir = testCase.roots?.markerDir ?? path.join(root, 'markers');
  await fs.mkdir(reservedRoot, { recursive: true });
  await fs.mkdir(aliasDir, { recursive: true });
  await fs.mkdir(markerDir, { recursive: true });
  await testCase.seed?.({ reservedRoot, aliasDir, markerDir });

  const grant = randomBytes(32).toString('hex');
  const origin = await serveArtifacts(testCase.objects, grant, testCase.origin ?? {});
  // The installer refuses a non-Linux host, so non-Linux hosts run the command in
  // the pinned Linux fixture container against the same mounted reserved root.
  const dockerized = process.platform !== 'linux';
  if (dockerized) ensureFixtureImage();
  const launchId = testCase.launchId ?? randomBytes(16).toString('hex');
  const deadlineAt =
    testCase.deadlineInMs === undefined ? undefined : Date.now() + testCase.deadlineInMs;
  try {
    const reserved = dockerized ? '/work/reserved' : reservedRoot;
    const alias = dockerized ? '/work/alias' : aliasDir;
    const markers = dockerized ? '/work/markers' : markerDir;
    const processOrigin = dockerized
      ? origin.origin.replace('127.0.0.1', 'host.docker.internal')
      : origin.origin;
    const env: Record<string, string> = {
      [RUNTIME_DESCRIPTOR_ENV]: JSON.stringify(testCase.descriptor),
      [RUNTIME_ARTIFACT_GRANT_ENV]: grant,
      [RUNTIME_ARTIFACT_ORIGIN_ENV]: processOrigin,
      [RUNTIME_DEADLINE_MS_ENV]: String(testCase.deadlineMs ?? 30_000),
      [RUNTIME_ALLOW_INSECURE_ORIGIN_ENV]: '1',
      KILO_RUNTIME_RESERVED_ROOT: reserved,
      KILO_RUNTIME_CLI_ROOT: `${reserved}/cli`,
      KILO_RUNTIME_CONTROL_ROOT: `${reserved}/control`,
      KILO_RUNTIME_RELEASES_ROOT: `${reserved}/releases`,
      KILO_RUNTIME_ACTIVE_POINTER: `${reserved}/active`,
      [RUNTIME_ALIAS_DIR_ENV]: alias,
      [MARKER_DIR_ENV]: markers,
    };
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      const command = testCase.command ?? runtimeLaunchCommand({ launchId, deadlineAt });
      const args = dockerized
        ? [
            'run',
            '--rm',
            '-v',
            `${path.dirname(reservedRoot)}:/work`,
            ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            FIXTURE_IMAGE,
            '/bin/sh',
            '-c',
            command,
          ]
        : ['-c', command];
      const child = spawn(dockerized ? 'docker' : '/bin/sh', args, {
        env: dockerized ? undefined : { ...process.env, ...env },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    const readMarker = async (name: string) => {
      const file = path.join(markerDir, name);
      return fsSync.existsSync(file) ? fs.readFile(file, 'utf8') : null;
    };
    // Read this launch's receipt through the shared path owner and the fixture's
    // own reserved root. A bundled command generates its own id, so it has none.
    const receiptEnabled = testCase.command === undefined;
    let launchReceipt: RuntimeLaunchReceipt | null = null;
    let launchReceiptError: string | null = null;
    if (receiptEnabled) {
      try {
        const text = await fs.readFile(runtimeLaunchReceiptPath(launchId, reservedRoot), 'utf8');
        launchReceipt = parseRuntimeLaunchReceipt(text, launchId);
      } catch (error) {
        launchReceiptError = error instanceof Error ? error.message : String(error);
      }
    }
    const run: InstallerRun = {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      reservedRoot,
      aliasDir,
      supervisorRan: fsSync.existsSync(path.join(markerDir, SUPERVISOR_MARKER)),
      supervisorEnv: await readMarker(SUPERVISOR_MARKER),
      descendantsEnv: await readMarker(`${SUPERVISOR_MARKER}.descendants`),
      cliProbeEnv: await readMarker(CLI_MARKER),
      launchId: receiptEnabled ? launchId : null,
      launchReceipt,
      launchReceiptError,
    };

    const flagLeak = (text: string | null) =>
      text !== null && text.includes(RUNTIME_ARTIFACT_GRANT_ENV);
    const problems: string[] = [];
    if (run.exitCode !== testCase.expectedExit) {
      problems.push(
        `exit=${run.exitCode} expected ${testCase.expectedExit} stderr=${run.stderr.trim()}`
      );
    }
    if (testCase.expectSupervisorRun !== run.supervisorRan) {
      problems.push(`supervisorRan=${run.supervisorRan} expected ${testCase.expectSupervisorRun}`);
    }
    if (flagLeak(run.supervisorEnv) || flagLeak(run.cliProbeEnv) || flagLeak(run.descendantsEnv)) {
      problems.push('grant leaked into probe, supervisor, or descendants');
    }
    if (testCase.expectSupervisorRun && run.cliProbeEnv === null)
      problems.push('CLI probe did not run');
    try {
      testCase.assert?.(run);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    return {
      name: testCase.name,
      passed: problems.length === 0,
      exitCode: run.exitCode,
      detail: problems.length === 0 ? 'ok' : problems.join('; '),
    };
  } finally {
    origin.close();
    if (owned) await fs.rm(root, { recursive: true, force: true });
  }
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function existsLstat(target: string): boolean {
  try {
    fsSync.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(target: string): boolean {
  try {
    return fsSync.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function releaseDirs(reservedRoot: string): string[] {
  const dir = path.join(reservedRoot, 'releases');
  return fsSync.existsSync(dir)
    ? fsSync.readdirSync(dir).filter(name => !name.startsWith('.'))
    : [];
}

/** Build and run the closed failure matrix plus the successful path. */
export async function runInstallerFaultMatrix(): Promise<InstallerCaseResult[]> {
  const packaged = await buildFixtureRelease();
  const cliBytes = packaged.cli.bytes;
  const controlBytes = packaged.control.bytes;
  const objects: ArtifactObject[] = [
    { sha256: packaged.cli.sha256, bytes: cliBytes },
    { sha256: packaged.control.sha256, bytes: controlBytes },
  ];
  const base = packaged.descriptor;
  const cliEntry = base.artifacts[0];
  const controlEntry = base.artifacts[1];
  const encoder = new TextEncoder();

  const withControl = (bytes: Uint8Array): ArtifactObject[] => [
    { sha256: packaged.cli.sha256, bytes: cliBytes },
    { sha256: sha256(bytes), bytes },
  ];
  const controlDescriptor = (bytes: Uint8Array): RuntimeReleaseDescriptor => ({
    ...base,
    artifacts: [
      cliEntry,
      { ...controlEntry, sha256: sha256(bytes), transferBytes: bytes.byteLength },
    ],
  });
  const gz = (entries: readonly { path: string; type: number; mode: number; data: Uint8Array }[]) =>
    gzipSync(buildRawTar(entries));

  const traversal = gz([
    { path: '../escape.sh', type: 48, mode: 0o100755, data: encoder.encode('x') },
  ]);
  const link = gz([
    {
      path: 'usr/local/bin/kilocode-control-plane-supervisor.sh',
      type: 50,
      mode: 0o100755,
      data: encoder.encode('usr/local/bin/other.sh\0'),
    },
  ]);
  const duplicate = gz([
    { path: 'usr/local/bin/dup.sh', type: 48, mode: 0o100755, data: encoder.encode('a') },
    { path: 'usr/local/bin/dup.sh', type: 48, mode: 0o100755, data: encoder.encode('b') },
  ]);
  const rawBig = buildRawTar([
    {
      path: 'usr/local/bin/truncated',
      type: 48,
      mode: 0o100755,
      data: encoder.encode('x'.repeat(4096)),
    },
  ]);
  const truncated = gzipSync(rawBig.subarray(0, 700));

  // Receipt-phase fixtures: a supervisor that exits 73 before hello, and a CLI
  // whose `--version` probe outlives the creation deadline.
  const supervisor73 = await buildFixtureRelease('supervisor-73', undefined, {
    supervisorExitCode: 73,
  });
  const slowProbe = await buildFixtureRelease('slow-probe', undefined, {
    cliProbeSleepSeconds: 15,
  });
  const probeFail = await buildFixtureRelease('probe-fail', undefined, { cliProbeExitCode: 3 });
  const noSupervisor = await buildFixtureRelease('no-supervisor', undefined, {
    omitSupervisor: true,
  });
  const receiptObjects = (release: Awaited<ReturnType<typeof buildFixtureRelease>>) => [
    { sha256: release.cli.sha256, bytes: release.cli.bytes },
    { sha256: release.control.sha256, bytes: release.control.bytes },
  ];

  const cases: InstallerCase[] = [
    {
      name: 'successful install activates the exact set and runs the probe and supervisor without the grant',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      seed: async ({ aliasDir }) => {
        await fs.mkdir(aliasDir, { recursive: true });
        await fs.writeFile(path.join(aliasDir, 'user-unrelated.tmp-user'), 'keep me\n');
      },
      assert: run => {
        expect(run.cliProbeEnv !== null, 'CLI probe did not run');
        expect(run.supervisorEnv !== null, 'supervisor did not run');
        expect(
          (run.supervisorEnv ?? '').includes(`${RUNTIME_CLI_PATH_ENV}=`),
          'cli path env not exported'
        );
        expect(releaseDirs(run.reservedRoot).length === 1, 'expected one release directory');
        const supervisorAlias = path.join(run.aliasDir, 'kilocode-control-plane-supervisor.sh');
        expect(isSymlink(supervisorAlias), 'supervisor alias missing or not a symlink');
        expect(
          fsSync.readlinkSync(supervisorAlias).includes('/active/control/'),
          'supervisor alias does not point through active'
        );
        expect(
          fsSync.existsSync(path.join(run.aliasDir, 'user-unrelated.tmp-user')),
          'an unrelated alias-dir file was removed'
        );
      },
    },
    {
      name: 'corrupt installed contents are repaired from authoritative bytes',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      seed: async ({ reservedRoot }) => {
        const target = path.join(reservedRoot, 'cli', packaged.cli.sha256, 'package', 'bin');
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'kilo'), 'corrupt\n', { mode: 0o755 });
      },
    },
    {
      name: 'unexpected installed file is repaired from authoritative bytes',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      seed: async ({ reservedRoot }) => {
        const target = path.join(reservedRoot, 'cli', packaged.cli.sha256, 'package');
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'extra.txt'), 'x\n');
      },
    },
    {
      name: 'corrupt installed contents with no authoritative bytes fail without exec',
      descriptor: base,
      objects: [],
      origin: { missing: true },
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactUnavailable,
      expectSupervisorRun: false,
      seed: async ({ reservedRoot }) => {
        const target = path.join(reservedRoot, 'cli', packaged.cli.sha256, 'package', 'bin');
        await fs.mkdir(target, { recursive: true });
        await fs.writeFile(path.join(target, 'kilo'), 'corrupt\n', { mode: 0o755 });
      },
      assert: run => {
        const quarantine = path.join(run.reservedRoot, '.quarantine');
        expect(fsSync.existsSync(quarantine), 'corrupt contents were not quarantined');
        expect(
          !existsLstat(path.join(run.aliasDir, 'kilocode-control-plane-supervisor.sh')),
          'alias exists after a failed install'
        );
      },
    },
    {
      name: 'archive hash mismatch does not exec',
      descriptor: base,
      objects: [
        { sha256: packaged.cli.sha256, bytes: Uint8Array.from(cliBytes, byte => byte ^ 0xff) },
        objects[1],
      ],
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'descriptor caps above the hard policy are rejected before any write',
      descriptor: {
        ...base,
        caps: { ...base.caps, maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT + 1 },
      },
      objects,
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'a declared file-count cap rejects a larger archive before any write',
      descriptor: { ...base, caps: { ...base.caps, maxFileCount: 1 } },
      objects,
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'a declared expansion cap rejects a larger archive before any write',
      descriptor: { ...base, caps: { ...base.caps, maxExpandedBytes: 1 } },
      objects,
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'traversal entry is rejected',
      descriptor: controlDescriptor(traversal),
      objects: withControl(traversal),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'link entry is rejected',
      descriptor: controlDescriptor(link),
      objects: withControl(link),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'duplicate archive path is rejected',
      descriptor: controlDescriptor(duplicate),
      objects: withControl(duplicate),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'truncated archive is rejected',
      descriptor: controlDescriptor(truncated),
      objects: withControl(truncated),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
    {
      name: 'a stalled fetch hits the total deadline without exec',
      descriptor: base,
      objects,
      origin: { stallMs: 5_000 },
      deadlineMs: 200,
      expectedExit: RUNTIME_INSTALLER_EXIT.deadlineExceeded,
      expectSupervisorRun: false,
    },
    {
      name: 'transient failures are retried within the bound',
      descriptor: base,
      objects,
      origin: { failuresBeforeSuccess: 2 },
      expectedExit: 0,
      expectSupervisorRun: true,
    },
    {
      name: 'a redirect is not followed and fails as unavailable',
      descriptor: base,
      objects,
      origin: { redirect: true },
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactUnavailable,
      expectSupervisorRun: false,
    },
    {
      name: 'missing artifact fails as unavailable without exec',
      descriptor: base,
      objects: [],
      origin: { missing: true },
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactUnavailable,
      expectSupervisorRun: false,
    },
    {
      name: 'rejected grant fails as unauthorized without exec',
      descriptor: base,
      objects,
      origin: { rejectGrant: true },
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactUnauthorized,
      expectSupervisorRun: false,
      assert: run => {
        expect(
          !existsLstat(path.join(run.aliasDir, 'kilocode-control-plane-supervisor.sh')),
          'alias exists after an unauthorized install'
        );
      },
    },
    {
      name: 'an interrupted install rerun succeeds and clears stale staging',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      seed: async ({ reservedRoot }) => {
        const stale = path.join(reservedRoot, 'cli', '.staging-stale');
        await fs.mkdir(stale, { recursive: true });
        await fs.writeFile(path.join(stale, 'partial'), 'x');
      },
      assert: run => {
        expect(
          !fsSync.existsSync(path.join(run.reservedRoot, 'cli', '.staging-stale')),
          'stale staging was not cleared'
        );
      },
    },
    {
      name: 'recovers a dangling pre-activation alias without dereferencing',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      seed: async ({ aliasDir }) => {
        await fs.mkdir(aliasDir, { recursive: true });
        // A dangling link lexically inside the reserved root, as left by a rollback
        // or an interrupted pre-activation. It must be replaced, not dereferenced.
        await fs.symlink(
          '../reserved/active/control/usr/local/bin/kilocode-control-plane-supervisor.sh',
          path.join(aliasDir, 'kilocode-control-plane-supervisor.sh')
        );
      },
    },
    {
      name: 'a successful launch writes the handoff receipt before the supervisor exec',
      descriptor: base,
      objects,
      expectedExit: 0,
      expectSupervisorRun: true,
      launchId: 'handoff-marker-launch',
      assert: run => {
        expect(run.cliProbeEnv !== null, 'CLI probe did not run');
        expect(run.launchReceipt !== null, 'handoff receipt was not written');
        expect(run.launchReceipt?.outcome === 'handoff', 'receipt outcome must be handoff');
        expect(
          run.launchReceipt?.launchId === 'handoff-marker-launch',
          'handoff receipt id mismatch'
        );
        const receiptPath = runtimeLaunchReceiptPath('handoff-marker-launch', run.reservedRoot);
        const fileMode = fsSync.statSync(receiptPath).mode & 0o777;
        expect(fileMode === 0o600, `receipt mode ${fileMode.toString(8)}`);
        const dirMode = fsSync.statSync(path.dirname(receiptPath)).mode & 0o777;
        expect(dirMode === 0o700, `receipt dir mode ${dirMode.toString(8)}`);
      },
    },
    {
      name: 'an installer failure writes the typed installer_failed receipt after cleanup',
      descriptor: controlDescriptor(link),
      objects: withControl(link),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
      launchId: 'failure-marker-launch',
      assert: run => {
        const receipt = run.launchReceipt;
        expect(
          receipt !== null && receipt.outcome === 'installer_failed',
          'typed installer_failed receipt missing'
        );
        if (receipt !== null && receipt.outcome === 'installer_failed') {
          expect(
            receipt.code === RUNTIME_INSTALLER_EXIT.artifactInvalid,
            `wrong receipt code ${receipt.code}`
          );
        }
      },
    },
    {
      name: 'a supervisor exit 73 before hello keeps the handoff receipt',
      descriptor: supervisor73.descriptor,
      objects: receiptObjects(supervisor73),
      expectedExit: 73,
      expectSupervisorRun: true,
      launchId: 'supervisor-73-launch',
      assert: run => {
        expect(run.exitCode === 73, `supervisor exit code ${run.exitCode} did not propagate`);
        expect(
          run.launchReceipt?.outcome === 'handoff',
          'a post-handoff supervisor exit must not become an artifact failure'
        );
      },
    },
    {
      name: 'a failed CLI probe writes the code 76 receipt and does not exec',
      descriptor: probeFail.descriptor,
      objects: receiptObjects(probeFail),
      expectedExit: RUNTIME_INSTALLER_EXIT.cliProbeFailed,
      expectSupervisorRun: false,
      launchId: 'probe-fail-launch',
      assert: run => {
        const receipt = run.launchReceipt;
        expect(
          receipt !== null && receipt.outcome === 'installer_failed',
          'code 76 receipt missing'
        );
        if (receipt !== null && receipt.outcome === 'installer_failed') {
          expect(
            receipt.code === RUNTIME_INSTALLER_EXIT.cliProbeFailed,
            `receipt code ${receipt.code}`
          );
        }
      },
    },
    {
      name: 'a missing supervisor writes the code 77 receipt and does not exec',
      descriptor: noSupervisor.descriptor,
      objects: receiptObjects(noSupervisor),
      expectedExit: RUNTIME_INSTALLER_EXIT.supervisorMissing,
      expectSupervisorRun: false,
      launchId: 'no-supervisor-launch',
      assert: run => {
        const receipt = run.launchReceipt;
        expect(
          receipt !== null && receipt.outcome === 'installer_failed',
          'code 77 receipt missing'
        );
        if (receipt !== null && receipt.outcome === 'installer_failed') {
          expect(
            receipt.code === RUNTIME_INSTALLER_EXIT.supervisorMissing,
            `receipt code ${receipt.code}`
          );
        }
      },
    },
    {
      name: 'an expired deadline during a slow probe cannot hand off',
      descriptor: slowProbe.descriptor,
      objects: receiptObjects(slowProbe),
      expectedExit: RUNTIME_INSTALLER_EXIT.deadlineExceeded,
      expectSupervisorRun: false,
      launchId: 'deadline-probe-launch',
      deadlineInMs: 5000,
      assert: run => {
        const receipt = run.launchReceipt;
        expect(!run.supervisorRan, 'supervisor must not run after the deadline');
        expect(
          receipt !== null && receipt.outcome === 'installer_failed',
          'deadline failure receipt missing'
        );
        if (receipt !== null && receipt.outcome === 'installer_failed') {
          expect(
            receipt.code === RUNTIME_INSTALLER_EXIT.deadlineExceeded,
            `deadline receipt code ${receipt.code}`
          );
        }
      },
    },
    {
      name: 'a stale receipt at the launch id blocks the handoff and is not replaced',
      descriptor: base,
      objects,
      expectedExit: RUNTIME_INSTALLER_EXIT.installInterrupted,
      expectSupervisorRun: false,
      launchId: 'stale-receipt-launch',
      seed: async ({ reservedRoot }) => {
        await fs.mkdir(path.join(reservedRoot, RUNTIME_LAUNCH_RECEIPT_DIR_NAME), {
          recursive: true,
        });
        await fs.writeFile(
          runtimeLaunchReceiptPath('stale-receipt-launch', reservedRoot),
          JSON.stringify({ launchId: 'foreign-launch', outcome: 'handoff' })
        );
      },
      assert: run => {
        expect(run.launchReceipt === null, 'a foreign receipt must not parse as this launch');
        expect(run.launchReceiptError !== null, 'expected a receipt read or parse error');
        expect(
          fsSync
            .readFileSync(
              runtimeLaunchReceiptPath('stale-receipt-launch', run.reservedRoot),
              'utf8'
            )
            .includes('foreign-launch'),
          'the stale receipt must not be replaced'
        );
      },
    },
    {
      name: 'a keepNames+minify bundled launch command installs a valid archive',
      descriptor: base,
      objects,
      command: await bundleLaunchCommand(),
      expectedExit: 0,
      expectSupervisorRun: true,
    },
    {
      name: 'a keepNames+minify bundled launch command rejects an unsupported archive',
      descriptor: controlDescriptor(link),
      objects: withControl(link),
      command: await bundleLaunchCommand(),
      expectedExit: RUNTIME_INSTALLER_EXIT.artifactInvalid,
      expectSupervisorRun: false,
    },
  ];

  const results: InstallerCaseResult[] = [];
  for (const testCase of cases) results.push(await runInstallerCase(testCase));
  results.push(await runRetentionCase());
  results.push(await runAliasRollbackCase());
  results.push(runReceiptContractCase());
  return results;
}

/** Strict receipt parsing: closed schema, bounded size, and id match. */
function runReceiptContractCase(): InstallerCaseResult {
  const name = 'the receipt parser is closed, bounded, and id-matched';
  const launchId = 'parser-launch-1';
  const root = '/fixture/reserved';
  const path = runtimeLaunchReceiptPath(launchId, root);
  try {
    expect(
      path === `${root}/${RUNTIME_LAUNCH_RECEIPT_DIR_NAME}/${launchId}.json`,
      `unexpected receipt path ${path}`
    );
    const handoff = parseRuntimeLaunchReceipt(
      '{"launchId":"parser-launch-1","outcome":"handoff"}',
      launchId
    );
    expect(handoff.outcome === 'handoff', 'handoff receipt did not parse');
    const failure = parseRuntimeLaunchReceipt(
      '{"launchId":"parser-launch-1","outcome":"installer_failed","code":76}',
      launchId
    );
    expect(
      failure.outcome === 'installer_failed' && failure.code === 76,
      'code 76 failure receipt did not parse'
    );
    const rejects = (input: string, expectedId?: string) => {
      try {
        parseRuntimeLaunchReceipt(input, expectedId);
        return false;
      } catch {
        return true;
      }
    };
    expect(
      rejects('{"launchId":"other","outcome":"handoff"}', launchId),
      'an id mismatch must be rejected'
    );
    expect(
      rejects('{"launchId":"parser-launch-1","outcome":"installer_failed","code":99}', launchId),
      'a code outside 70-77 must be rejected'
    );
    expect(rejects('{"launchId":"parser-launch-1","outcome":"unknown"}'), 'unknown outcome');
    expect(rejects('not json', launchId), 'malformed JSON must be rejected');
    expect(
      rejects(`{"launchId":"parser-launch-1","outcome":"handoff","extra":true}`, launchId),
      'an unknown key must be rejected'
    );
    expect(rejects(`{"launchId":"${'a'.repeat(600)}","outcome":"handoff"}`), 'oversized receipt');
    expect(rejects(`{"launchId":"a/b","outcome":"handoff"}`), 'unsafe launch id in a receipt');
    let pathRejected = false;
    try {
      runtimeLaunchReceiptPath('../escape');
    } catch {
      pathRejected = true;
    }
    expect(pathRejected, 'an unsafe launch id must not produce a receipt path');
    return { name, passed: true, exitCode: 0, detail: 'ok' };
  } catch (error) {
    return {
      name,
      passed: false,
      exitCode: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** A -> B (extra control alias) -> A -> B must roll aliases forward on one root set. */
async function runAliasRollbackCase(): Promise<InstallerCaseResult> {
  const name = 'aliases roll forward through A, B with an extra alias, A, then B';
  const ownedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-alias-rollback-'));
  const roots = {
    reservedRoot: path.join(ownedRoot, 'reserved'),
    aliasDir: path.join(ownedRoot, 'alias'),
    markerDir: path.join(ownedRoot, 'markers'),
  };
  const encoder = new TextEncoder();
  try {
    const releaseA = await buildFixtureRelease('rollback-a');
    const releaseB = await buildFixtureRelease('rollback-b', {
      path: 'usr/local/bin/kilo-extra-tool',
      bytes: encoder.encode('#!/bin/sh\nexit 0\n'),
    });
    for (const packaged of [releaseA, releaseB, releaseA, releaseB]) {
      const result = await runInstallerCase({
        name,
        descriptor: packaged.descriptor,
        objects: [
          { sha256: packaged.cli.sha256, bytes: packaged.cli.bytes },
          { sha256: packaged.control.sha256, bytes: packaged.control.bytes },
        ],
        expectedExit: 0,
        expectSupervisorRun: true,
        roots,
      });
      if (!result.passed) {
        return { ...result, name, detail: `rollback step failed: ${result.detail}` };
      }
    }
    const supervisorAlias = path.join(roots.aliasDir, 'kilocode-control-plane-supervisor.sh');
    const extraAlias = path.join(roots.aliasDir, 'kilo-extra-tool');
    const supervisorOk =
      isSymlink(supervisorAlias) &&
      fsSync.readlinkSync(supervisorAlias).includes('/active/control/');
    const extraOk =
      isSymlink(extraAlias) && fsSync.readlinkSync(extraAlias).includes('/active/control/');
    return {
      name,
      passed: supervisorOk && extraOk,
      exitCode: 0,
      detail: supervisorOk && extraOk ? 'ok' : `supervisor=${supervisorOk} extra=${extraOk}`,
    };
  } finally {
    await fs.rm(ownedRoot, { recursive: true, force: true });
  }
}

/** Three control releases must retain only the active plus one previous verified set. */
async function runRetentionCase(): Promise<InstallerCaseResult> {
  const name = 'retention keeps only the active and previous verified release set';
  const ownedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-retention-'));
  const roots = {
    reservedRoot: path.join(ownedRoot, 'reserved'),
    aliasDir: path.join(ownedRoot, 'alias'),
    markerDir: path.join(ownedRoot, 'markers'),
  };
  try {
    const releaseA = await buildFixtureRelease('retain-a');
    const releaseB = await buildFixtureRelease('retain-b');
    const releaseC = await buildFixtureRelease('retain-c');
    // A, B, B (same release re-boot must keep the existing rollback), A, then C.
    // The final set keeps the release active before C (A), not the newest (B).
    for (const packaged of [releaseA, releaseB, releaseB, releaseA, releaseC]) {
      const result = await runInstallerCase({
        name,
        descriptor: packaged.descriptor,
        objects: [
          { sha256: packaged.cli.sha256, bytes: packaged.cli.bytes },
          { sha256: packaged.control.sha256, bytes: packaged.control.bytes },
        ],
        expectedExit: 0,
        expectSupervisorRun: true,
        roots,
      });
      if (!result.passed)
        return { ...result, name, detail: `release step failed: ${result.detail}` };
    }
    const retained = releaseDirs(roots.reservedRoot).sort();
    const expected = [
      `${releaseA.cli.sha256}-${releaseA.control.sha256}`,
      `${releaseC.cli.sha256}-${releaseC.control.sha256}`,
    ].sort();
    const cliDirs = fsSync.existsSync(path.join(roots.reservedRoot, 'cli'))
      ? fsSync
          .readdirSync(path.join(roots.reservedRoot, 'cli'))
          .filter(entry => !entry.startsWith('.'))
      : [];
    const passed =
      retained.length === 2 &&
      retained[0] === expected[0] &&
      retained[1] === expected[1] &&
      cliDirs.length === 1;
    return {
      name,
      passed,
      exitCode: 0,
      detail: passed
        ? 'ok'
        : `retained [${retained.join(', ')}] expected [${expected.join(', ')}] cliDirs=${cliDirs.length}`,
    };
  } finally {
    await fs.rm(ownedRoot, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const results = await runInstallerFaultMatrix();
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'} ${result.name} (exit ${result.exitCode}) ${result.detail}\n`
    );
  }
  process.exit(results.every(result => result.passed) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
