#!/usr/bin/env bun
/**
 * Cold-local runtime preparation (amendment "cold session without a snapshot").
 *
 * It publishes the exact pinned CLI distribution and the current control bundles
 * to the local R2 the running Worker reads, then renders the generated
 * `.wrangler/wrangler.cold-local.jsonc` config. That config embeds the exact
 * descriptor and the artifact origin, and points the sandbox class a local
 * session starts in at `Dockerfile.runtime-free`. A session then boots the
 * runtime-free image and the launch installs the published runtime; no snapshot
 * and no baked CLI are used.
 *
 * Subcommands:
 *   prepare   Publish the pinned release and render the cold-local config.
 *   cert      Generate the local HTTPS forwarder certificate.
 *   forwarder Run the HTTPS artifact forwarder (long-lived; used as an
 *             inherited background process) and print its port and cert paths.
 *
 * Usage:
 *   pnpm --filter cloud-agent-next exec tsx scripts/cold-local-runtime.ts prepare \
 *     --origin <https-forwarder-origin> [--bucket <name>] [--persist-to <dir>] \
 *     [--class <name>]... [--ca-pem-file <path>]
 *   pnpm --filter cloud-agent-next exec tsx scripts/cold-local-runtime.ts cert --dir <dir>
 *   pnpm --filter cloud-agent-next exec tsx scripts/cold-local-runtime.ts forwarder \
 *     --dir <dir> [--worker-url <url>] [--port <n>]
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';

import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  WRAPPER_BUNDLES,
} from '../src/shared/runtime-distribution.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  parseTrustedRuntimeArtifactOrigin,
  serializeRuntimeRelease,
} from '../src/shared/runtime-release.js';
import { serializedLocalStore } from './local-r2-store.js';
import {
  controlBundleEntries,
  packageRuntimeRelease,
  publishRuntimeRelease,
} from './publish-runtime.js';
import { downloadVerified, PINNED_CLI_SHA256, PINNED_CLI_VERSION } from './runtime-cli-artifact.js';
import { ensureValidForwarderCertificate, startHttpsForwarder } from './runtime-https-forwarder.js';
import {
  coldLocalRenderPaths,
  buildColdLocalWorkerConfig,
  renderColdLocal,
} from '../test/e2e/deploy/render-e2e-worker-config.mjs';

const exec = promisify(execFile);
const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BUCKET = 'kilocode-cloud-agent-releases-dev';
const DEFAULT_PERSIST_TO = path.join(SERVICE_ROOT, '.wrangler', 'state');
const DEFAULT_TEMP_DIR = path.join(SERVICE_ROOT, '.cold-local-tmp');
const TEMP_DIR = DEFAULT_TEMP_DIR;
// The tested process matrix publishes this same label; the descriptor carries it
// verbatim so the cold session and the upgrade driver exercise one release shape.
const RELEASE_PROTOCOL = 'control-plane-v1';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

type Options = {
  command: 'prepare' | 'cert' | 'forwarder';
  origin?: string;
  bucket: string;
  persistTo: string;
  classes: string[];
  caPemFile?: string;
  dir?: string;
  workerUrl?: string;
  port?: number;
};

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'prepare',
    bucket: DEFAULT_BUCKET,
    persistTo: DEFAULT_PERSIST_TO,
    classes: ['Sandbox'],
  };
  const valueFlags: Record<string, (value: string) => void> = {
    '--origin': value => (options.origin = value),
    '--bucket': value => (options.bucket = value),
    '--persist-to': value => (options.persistTo = value),
    '--class': value => options.classes.push(value),
    '--ca-pem-file': value => (options.caPemFile = value),
    '--dir': value => (options.dir = value),
    '--worker-url': value => (options.workerUrl = value),
    '--port': value => (options.port = Number(value)),
  };
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const handler = valueFlags[flag];
    if (handler) {
      const value = eq === -1 ? argv[(index += 1)] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`${flag} requires a value`);
      handler(value);
    } else {
      rest.push(arg);
    }
  }
  const command = rest[0];
  if (command === 'prepare' || command === 'cert' || command === 'forwarder')
    options.command = command;
  else
    throw new Error(
      `unknown subcommand ${command ?? '(none)'}; expected prepare, cert or forwarder`
    );
  return options;
}

function readDevVarsValue(name: string): string | undefined {
  const file = path.join(SERVICE_ROOT, '.dev.vars');
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = new RegExp(`^${name}\\s*=\\s*(.*)$`).exec(line.trim());
    if (match) return match[1].replace(/^["']|["']$/g, '');
  }
  return undefined;
}

function buildControlEntries() {
  return controlBundleEntries(SERVICE_ROOT);
}

async function prepare(options: Options): Promise<void> {
  // Validate the artifact origin before any publication: a missing or non-HTTPS
  // origin must fail here rather than produce a config that cannot launch. The
  // rule is the shared contract owner; the provider applies the same guard.
  if (options.origin === undefined) {
    throw new Error(
      'prepare requires an explicit --origin (the bare HTTPS artifact forwarder origin, e.g. https://host.docker.internal:9599)'
    );
  }
  const origin = parseTrustedRuntimeArtifactOrigin(options.origin);
  if (origin === null) {
    throw new Error(
      `--origin must be a bare HTTPS origin with no credentials, path, query, or fragment: ${options.origin}`
    );
  }

  if (!fs.existsSync(path.join(SERVICE_ROOT, 'wrapper', 'dist'))) {
    await exec('pnpm', ['--filter', 'cloud-agent-next', 'run', 'build:wrapper'], {
      cwd: SERVICE_ROOT,
    });
  }

  const cliBytes = await downloadVerified(PINNED_CLI_VERSION);
  if (sha256(cliBytes) !== PINNED_CLI_SHA256) {
    throw new Error('pinned CLI does not match the measured baseline hash');
  }
  const packaged = await packageRuntimeRelease({
    cliTarball: cliBytes,
    cliVersion: PINNED_CLI_VERSION,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: PINNED_CLI_VERSION,
    protocol: RELEASE_PROTOCOL,
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries: await buildControlEntries(),
  });

  const descriptorBytes = serializeRuntimeRelease(packaged.descriptor);
  if (descriptorBytes.byteLength > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    throw new Error('runtime descriptor exceeded the launch cap after publication');
  }
  const descriptor = new TextDecoder().decode(descriptorBytes);

  const localCaPem =
    options.caPemFile === undefined ? undefined : fs.readFileSync(options.caPemFile, 'utf8');

  const paths = coldLocalRenderPaths();
  const buildVars = {
    // No private copy of the version: the shared owner supplies it, and the
    // runtime-free Dockerfile has a no-default ARG for it.
    BUN_VERSION: RUNTIME_DISTRIBUTION.bun,
  };
  const renderOptions = {
    runtimeReleaseDescriptor: descriptor,
    runtimeReleaseBucket: options.bucket,
    artifactOrigin: origin,
    runtimeFreeClasses: options.classes,
    localCaPem,
    buildVars,
    paths,
  };
  buildColdLocalWorkerConfig(
    parseJsonc(fs.readFileSync(paths.sourceConfigPath, 'utf8')),
    renderOptions
  );
  const store = serializedLocalStore({
    bucket: options.bucket,
    serviceRoot: SERVICE_ROOT,
    tempDir: TEMP_DIR,
    persistTo: options.persistTo,
  });
  const publication = await publishRuntimeRelease(store, packaged);
  renderColdLocal(renderOptions);

  console.log(
    JSON.stringify(
      {
        descriptorSha256: sha256(descriptorBytes),
        descriptorBytes: descriptorBytes.byteLength,
        cliSha256: packaged.cli.sha256,
        controlSha256: packaged.control.sha256,
        evidenceKey: publication.evidence.key,
        origin,
        classes: options.classes,
        buildVars,
        trustedLocalCa: localCaPem !== undefined,
        configPath: paths.targetConfigPath,
        devVarsPath: paths.localDevVarsPath,
        runtimeFreeImage: 'Dockerfile.runtime-free',
        distribution: RUNTIME_DISTRIBUTION,
        wrapperBundles: WRAPPER_BUNDLES.map(bundle => bundle.installName),
        supervisor: CONTROL_PLANE_SUPERVISOR.installName,
        gitCredentialHelper: GIT_CREDENTIAL_HELPER.installName,
      },
      null,
      2
    )
  );
}

async function cert(options: Options): Promise<void> {
  if (!options.dir) throw new Error('cert requires --dir');
  const { keyPath, certPath } = await ensureValidForwarderCertificate(options.dir);
  console.log(JSON.stringify({ keyPath, certPath }, null, 2));
}

async function forwarder(options: Options): Promise<void> {
  if (!options.dir) throw new Error('forwarder requires --dir');
  const dir = options.dir;
  // A stack outliving the one-day certificate would fail TLS inside the
  // container (exit 70); reuse only a matching, non-expiring pair.
  const { keyPath, certPath } = await ensureValidForwarderCertificate(dir);
  const workerUrl = options.workerUrl ?? readDevVarsValue('WORKER_URL');
  if (!workerUrl) throw new Error('forwarder requires --worker-url or WORKER_URL in .dev.vars');
  const forwarder = await startHttpsForwarder(workerUrl, keyPath, certPath, options.port ?? 0);
  // One machine-readable line before staying up, so a supervising process can
  // read the dynamic port, the origin and the CA path it must bake.
  console.log(
    JSON.stringify({
      pid: process.pid,
      port: forwarder.port,
      origin: forwarder.origin,
      keyPath,
      certPath,
      caPemPath: certPath,
      workerUrl,
    })
  );
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.command === 'prepare') await prepare(options);
    else if (options.command === 'cert') await cert(options);
    else await forwarder(options);
  } finally {
    await fsPromises.rm(DEFAULT_TEMP_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
