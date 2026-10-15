#!/usr/bin/env bun
/**
 * Runtime upgrade E2E driver (execution plan §9). Run by an operator with the
 * local stack up; it is not part of `pnpm test:all`.
 *
 * It publishes the exact CLI A, CLI B and wrapper-only packages to the R2 the
 * running Worker reads, then exercises a persisted fixture volume through the
 * serialized launch command. The fixture container downloads over a local HTTPS
 * forwarder that serves zero bytes itself: it proxies every artifact request to
 * the live Worker route with the container's real signed grant.
 *
 *   - CLI-only: CLI A (measured 7.8.1) -> CLI B (pinned 7.8.9). After B a named
 *     non-binary installed file on disk differs from A, a real dependency import
 *     still succeeds, and B is the executed CLI.
 *   - Wrapper-only: active/control points at the new control hash, the CLI object
 *     is not refetched, and the CLI non-binary disk hash is unchanged.
 *   - Missing intercept CA fails with the installer's unavailable exit code and
 *     installs nothing.
 *
 * Publication is create-only through a strict serialized owner: check and put run
 * under one exclusive lock, and every write is re-read and byte-verified.
 *
 * Usage:
 *   bun test/e2e/runtime-upgrade.ts [--worker-url=http://localhost:9494]
 *     [--bucket=kilocode-cloud-agent-releases-dev] [--persist-to=<dir>] [--publish-only]
 */

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mintRuntimeArtifactGrant } from '../../src/sandbox-control/runtime-artifact-grant.js';
import {
  RUNTIME_ARTIFACT_GRANT_ENV,
  RUNTIME_ARTIFACT_ORIGIN_ENV,
  RUNTIME_DEADLINE_MS_ENV,
  RUNTIME_DESCRIPTOR_ENV,
  runtimeLaunchCommand,
} from '../../src/sandbox-control/runtime-bootstrap.js';
import { RUNTIME_INSTALLER_EXIT } from '../../src/sandbox-control/runtime-launch-receipt.js';
import { ensureFixtureImage } from '../../scripts/runtime-installer.js';
import { serializedLocalStore } from '../../scripts/local-r2-store.js';
import {
  downloadVerified,
  PINNED_CLI_SHA256,
  PINNED_CLI_VERSION,
} from '../../scripts/runtime-cli-artifact.js';
import {
  generateForwarderCertificate,
  startHttpsForwarder,
} from '../../scripts/runtime-https-forwarder.js';
import {
  controlBundleEntries,
  packageRuntimeRelease,
  publishRuntimeRelease,
  type PackagedRuntime,
} from '../../scripts/publish-runtime.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  runtimeArtifactHashes,
  runtimeArtifactHttpPath,
  serializeRuntimeRelease,
} from '../../src/shared/runtime-release.js';

const exec = promisify(execFile);
const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE_IMAGE = 'kilo-runtime-base-fixture:test';
const CLI_B_VERSION = '7.8.9';
const DEPS_VOLUME_PATH = '/deps';
const DEP_PACKAGE = 'left-pad@1.3.0';
const TMP = path.join(SERVICE_ROOT, '.runtime-upgrade-tmp');
const INSTALL_TIMEOUT_MS = 180_000;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

type ControlEntries = Awaited<ReturnType<typeof controlBundleEntries>>;

type Options = {
  workerUrl: string;
  bucket: string;
  persistTo?: string;
  publishOnly: boolean;
  keepResources: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    workerUrl: 'http://localhost:9494',
    bucket: 'kilocode-cloud-agent-releases-dev',
    publishOnly: false,
    keepResources: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--worker-url=')) options.workerUrl = arg.slice('--worker-url='.length);
    else if (arg.startsWith('--bucket=')) options.bucket = arg.slice('--bucket='.length);
    else if (arg.startsWith('--persist-to=')) options.persistTo = arg.slice('--persist-to='.length);
    else if (arg === '--publish-only') options.publishOnly = true;
    else if (arg === '--keep-resources') options.keepResources = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

async function resolveSecret(): Promise<string> {
  const vars = fsSync.readFileSync(path.join(SERVICE_ROOT, '.dev.vars'), 'utf8');
  for (const line of vars.split('\n')) {
    const match = /^NEXTAUTH_SECRET\s*=\s*(.*)$/.exec(line.trim());
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  throw new Error('NEXTAUTH_SECRET is not present in .dev.vars');
}

async function assertLiveGet(
  workerUrl: string,
  secret: string,
  hashes: [string, string]
): Promise<void> {
  for (const hash of hashes) {
    const grant = mintRuntimeArtifactGrant({ hashes }, secret);
    const response = await fetch(
      `${workerUrl.replace(/\/$/, '')}${runtimeArtifactHttpPath(hash)}`,
      {
        headers: { Authorization: `Bearer ${grant}` },
      }
    );
    if (response.status !== 200)
      throw new Error(`live GET for ${hash} returned ${response.status}`);
    if (sha256(new Uint8Array(await response.arrayBuffer())) !== hash) {
      throw new Error(`live GET for ${hash} returned different bytes`);
    }
  }
}

function packageFor(
  bytes: Uint8Array,
  version: string,
  controlEntries: ControlEntries
): Promise<PackagedRuntime> {
  return packageRuntimeRelease({
    cliTarball: bytes,
    cliVersion: version,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: version,
    protocol: 'control-plane-v1',
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries,
  });
}

/** A named non-binary CLI file that is present in the real package. */
function nonBinaryAsset(packaged: PackagedRuntime): string {
  const cli = packaged.descriptor.inventory.filter(entry => entry[0] === 'cli');
  const preferred = cli.find(entry => entry[1] === 'package/package.json');
  if (preferred) return preferred[1];
  const js = cli.find(entry => entry[1].endsWith('.js') && (entry[2] & 0o111) === 0);
  if (!js) throw new Error('no non-binary CLI asset found');
  return js[1];
}

function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('docker', args);
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
}

export type VolumeCaseResult = { name: string; passed: boolean; detail: string };

async function runVolumeCases(
  cliA: PackagedRuntime,
  workerUrl: string,
  bucket: string,
  persistTo: string | undefined,
  keepResources: boolean
): Promise<VolumeCaseResult[]> {
  const results: VolumeCaseResult[] = [];
  ensureFixtureImage();
  await fs.mkdir(TMP, { recursive: true });
  const runId = randomBytes(4).toString('hex');
  const runtimeVolume = `kilo-runtime-e2e-${runId}-runtime`;
  const depsVolume = `kilo-runtime-e2e-${runId}-deps`;
  const container = `kilo-runtime-e2e-${runId}`;
  const certDir = path.join(TMP, `ca-${runId}`);
  const createdVolumes: string[] = [];
  const onVolume = (script: string): string[] => [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '-v',
    `${runtimeVolume}:/opt/kilo-cloud`,
    FIXTURE_IMAGE,
    'sh',
    '-c',
    script,
  ];
  try {
    await fs.mkdir(certDir, { recursive: true });
    const { keyPath, certPath } = await generateForwarderCertificate(certDir);
    for (const volume of [runtimeVolume, depsVolume]) {
      await docker(['volume', 'create', volume]);
      createdVolumes.push(volume);
    }

    const seed = await docker([
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '-v',
      `${depsVolume}:${DEPS_VOLUME_PATH}`,
      FIXTURE_IMAGE,
      'sh',
      '-c',
      `cd ${DEPS_VOLUME_PATH} && bun add ${DEP_PACKAGE}`,
    ]);
    if (seed.code !== 0) throw new Error(`dependency seed failed: ${seed.stderr.trim()}`);
    const depsSentinel = async () =>
      (
        await docker([
          'run',
          '--rm',
          '--platform',
          'linux/amd64',
          '-v',
          `${depsVolume}:${DEPS_VOLUME_PATH}`,
          FIXTURE_IMAGE,
          'sh',
          '-c',
          `cd ${DEPS_VOLUME_PATH} && find . -type f | sort | xargs sha256sum | sha256sum`,
        ])
      ).stdout.trim();
    const depsSentinelBefore = await depsSentinel();
    const assertDependencyImport = async (label: string) => {
      const check = await docker([
        'run',
        '--rm',
        '--platform',
        'linux/amd64',
        '-v',
        `${depsVolume}:${DEPS_VOLUME_PATH}`,
        FIXTURE_IMAGE,
        'bun',
        '-e',
        `process.stdout.write(require('${DEPS_VOLUME_PATH}/node_modules/left-pad')(7, 3, 0))`,
      ]);
      if (check.code !== 0 || check.stdout.trim() !== '007') {
        throw new Error(`${label}: dependency import failed (${check.stderr.trim()})`);
      }
    };
    await assertDependencyImport('baseline');

    const publishStore = serializedLocalStore({
      bucket,
      serviceRoot: SERVICE_ROOT,
      tempDir: TMP,
      persistTo,
    });

    const activeCliPath = async (): Promise<string | null> => {
      const listing = await docker(
        onVolume('readlink -f /opt/kilo-cloud/active/cli/package/bin/kilo 2>/dev/null')
      );
      return listing.code === 0 && listing.stdout.trim() !== '' ? listing.stdout.trim() : null;
    };
    const activeControlHash = async (): Promise<string | null> => {
      const listing = await docker(
        onVolume('readlink -f /opt/kilo-cloud/active/control 2>/dev/null')
      );
      const value = listing.stdout.trim();
      return listing.code === 0 && value !== '' ? path.basename(value) : null;
    };
    const installedSha = async (relative: string): Promise<string | null> => {
      const listing = await docker(
        onVolume(`sha256sum "/opt/kilo-cloud/active/cli/${relative}" 2>/dev/null`)
      );
      const value = listing.stdout.trim().split(/\s+/)[0];
      return listing.code === 0 && value ? value : null;
    };
    const cliVersion = async (): Promise<{ code: number; stdout: string }> => {
      const run = await docker(
        onVolume('exec /opt/kilo-cloud/active/cli/package/bin/kilo --version 2>&1')
      );
      return { code: run.code, stdout: run.stdout.trim() };
    };

    const runRelease = async (
      packaged: PackagedRuntime,
      secret: string,
      withCa: boolean,
      expectActivated: () => Promise<boolean>
    ): Promise<{ activated: boolean; exitCode: number | null; requests: string[] }> => {
      await publishRuntimeRelease(publishStore, packaged);
      const grant = mintRuntimeArtifactGrant(
        { hashes: runtimeArtifactHashes(packaged.descriptor) },
        secret
      );
      const forwarder = await startHttpsForwarder(workerUrl, keyPath, certPath);
      const descriptor = new TextDecoder().decode(serializeRuntimeRelease(packaged.descriptor));
      await docker(['rm', '-f', container]);
      const args = [
        'run',
        '-d',
        '--name',
        container,
        '--platform',
        'linux/amd64',
        '-v',
        `${runtimeVolume}:/opt/kilo-cloud`,
        '-v',
        `${depsVolume}:${DEPS_VOLUME_PATH}`,
      ];
      if (withCa) args.push('-v', `${certDir}:/ca:ro`);
      const env: Record<string, string> = {
        [RUNTIME_DESCRIPTOR_ENV]: descriptor,
        [RUNTIME_ARTIFACT_GRANT_ENV]: grant,
        [RUNTIME_ARTIFACT_ORIGIN_ENV]: forwarder.origin,
        [RUNTIME_DEADLINE_MS_ENV]: String(INSTALL_TIMEOUT_MS),
        ...(withCa ? { NODE_EXTRA_CA_CERTS: '/ca/cert.pem' } : {}),
      };
      for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
      args.push(FIXTURE_IMAGE, '/bin/sh', '-c', runtimeLaunchCommand());
      const started = await docker(args);
      if (started.code !== 0) throw new Error(`container start failed: ${started.stderr.trim()}`);

      let activated = false;
      let exitCode: number | null = null;
      const deadline = Date.now() + INSTALL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const running = (
          await docker(['inspect', '-f', '{{.State.Running}}', container])
        ).stdout.trim();
        if (running === 'false') {
          exitCode = Number(
            (await docker(['inspect', '-f', '{{.State.ExitCode}}', container])).stdout.trim()
          );
          break;
        }
        if (await expectActivated()) {
          activated = true;
          break;
        }
        await sleep(500);
      }
      await docker(['rm', '-f', container]);
      await forwarder.close();
      return { activated, exitCode, requests: forwarder.requests };
    };

    // Missing CA fails with the installer's unavailable exit code and installs nothing.
    const secret = await resolveSecret();
    const noCa = await runRelease(cliA, secret, false, async () => false);
    results.push({
      name: 'a missing intercept CA fails with code 70 and installs nothing',
      passed: noCa.exitCode === RUNTIME_INSTALLER_EXIT.artifactUnavailable && !noCa.activated,
      detail: `exit=${noCa.exitCode} activated=${noCa.activated}`,
    });

    // CLI A install.
    const a = await runRelease(
      cliA,
      secret,
      true,
      async () =>
        (await activeCliPath())?.endsWith(`/cli/${cliA.cli.sha256}/package/bin/kilo`) ?? false
    );
    if (!a.activated) throw new Error('CLI A did not activate');
    const aCli = await activeCliPath();
    if (aCli === null || !aCli.endsWith(`/cli/${cliA.cli.sha256}/package/bin/kilo`)) {
      throw new Error(`CLI A is not the installed runtime: ${aCli}`);
    }
    const assetPath = nonBinaryAsset(cliA);
    const assetASha = await installedSha(assetPath);
    if (assetASha === null) throw new Error('CLI A non-binary asset is missing on disk');

    // CLI B (pinned, verified by registry integrity).
    const cliB = await packageFor(
      await downloadVerified(CLI_B_VERSION),
      CLI_B_VERSION,
      await controlBundleEntries(SERVICE_ROOT)
    );
    if (cliB.cli.sha256 === cliA.cli.sha256) throw new Error('CLI B must differ from CLI A');
    const b = await runRelease(
      cliB,
      secret,
      true,
      async () =>
        (await activeCliPath())?.endsWith(`/cli/${cliB.cli.sha256}/package/bin/kilo`) ?? false
    );
    if (!b.activated) throw new Error('CLI B did not activate');
    const bCli = await activeCliPath();
    const assetBSha = await installedSha(assetPath);
    const version = await cliVersion();
    results.push({
      name: 'CLI upgrade installs B, executes B, and changes the installed non-binary asset',
      passed:
        b.requests.includes(cliB.cli.sha256) &&
        bCli !== null &&
        bCli.endsWith(`/cli/${cliB.cli.sha256}/package/bin/kilo`) &&
        assetBSha !== null &&
        assetBSha !== assetASha &&
        version.code === 0 &&
        version.stdout.includes(CLI_B_VERSION),
      detail: `${CLI_B_VERSION}: cli=${bCli} asset=${assetBSha ?? 'none'} version=${version.stdout}`,
    });
    await assertDependencyImport('after CLI B');
    results.push({
      name: 'the shared dependency volume is unchanged across the CLI upgrade',
      passed: (await depsSentinel()) === depsSentinelBefore,
      detail: 'dependency sentinel',
    });

    // Wrapper-only: new control bundle, CLI object not refetched or changed.
    const controlEntriesB: ControlEntries = [
      ...(await controlBundleEntries(SERVICE_ROOT)),
      {
        path: 'opt/kilo-cloud/.control-build',
        mode: 0o100644,
        bytes: encoder.encode(`build-${runId}`),
      },
    ];
    const wrapperPackage = await packageFor(
      await downloadVerified(CLI_B_VERSION),
      CLI_B_VERSION,
      controlEntriesB
    );
    if (wrapperPackage.control.sha256 === cliB.control.sha256) {
      throw new Error('wrapper-only control bundle did not change');
    }
    const wrapper = await runRelease(
      wrapperPackage,
      secret,
      true,
      async () => (await activeControlHash()) === wrapperPackage.control.sha256
    );
    const wrapperControl = await activeControlHash();
    results.push({
      name: 'wrapper-only upgrade changes control, keeps the CLI dir, and does not refetch the CLI',
      passed:
        wrapper.activated &&
        !wrapper.requests.includes(wrapperPackage.cli.sha256) &&
        wrapper.requests.includes(wrapperPackage.control.sha256) &&
        wrapperControl === wrapperPackage.control.sha256 &&
        (await activeCliPath()) === bCli &&
        (await installedSha(assetPath)) === assetBSha,
      detail: `control=${wrapperControl ?? 'none'} requests=${wrapper.requests.length}`,
    });
    return results;
  } finally {
    await docker(['rm', '-f', container]);
    if (!keepResources) {
      for (const volume of createdVolumes) await docker(['volume', 'rm', '-f', volume]);
    }
    await fs.rm(certDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const secret = await resolveSecret();
  await fs.mkdir(TMP, { recursive: true });
  try {
    if (!fsSync.existsSync(path.join(SERVICE_ROOT, 'wrapper/dist'))) {
      await exec('pnpm', ['--filter', 'cloud-agent-next', 'run', 'build:wrapper'], {
        cwd: SERVICE_ROOT,
      });
    }
    const controlEntries = await controlBundleEntries(SERVICE_ROOT);
    const cliABytes = await downloadVerified(PINNED_CLI_VERSION);
    if (sha256(cliABytes) !== PINNED_CLI_SHA256)
      throw new Error('CLI A does not match the measured baseline hash');
    const cliA = await packageFor(cliABytes, PINNED_CLI_VERSION, controlEntries);

    const store = serializedLocalStore({
      bucket: options.bucket,
      serviceRoot: SERVICE_ROOT,
      tempDir: TMP,
      persistTo: options.persistTo,
    });
    const publication = await publishRuntimeRelease(store, cliA);
    console.log('published', JSON.stringify(publication));
    await assertLiveGet(options.workerUrl, secret, runtimeArtifactHashes(cliA.descriptor));
    console.log('live GET returned the published bytes');
    if (options.publishOnly) return;

    const { runInstallerFaultMatrix } = await import('../../scripts/runtime-installer.js');
    const matrix = await runInstallerFaultMatrix();
    for (const result of matrix) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}`);
    if (!matrix.every(result => result.passed))
      throw new Error('installer failure matrix did not pass');

    const volumes = await runVolumeCases(
      cliA,
      options.workerUrl,
      options.bucket,
      options.persistTo,
      options.keepResources
    );
    for (const result of volumes)
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`);
    if (!volumes.every(result => result.passed))
      throw new Error('volume upgrade cases did not pass');

    console.log(
      'Next: tsx services/cloud-agent-next/test/e2e/run.ts control-socket-recycle-boot _'
    );
  } finally {
    await fs.rm(TMP, { recursive: true, force: true });
  }
}

await main();
