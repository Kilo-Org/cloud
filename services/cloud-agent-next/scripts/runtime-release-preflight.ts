#!/usr/bin/env bun
/**
 * Read-only runtime release preflight (amendment "cold session without a
 * snapshot").
 *
 * It verifies one published release before a Worker config embeds its
 * descriptor, and it never publishes or deploys:
 *   - the descriptor is at or below the launch byte cap and parses;
 *   - its declared ABI is the required base contract;
 *   - both artifact objects exist in the bucket with the declared size and hash;
 *   - the release-evidence object exists and is byte-identical to the descriptor;
 *   - the base Dockerfiles still declare the tested generic toolchain and the
 *     runtime-free image still carries no baked Kilo runtime.
 *
 * A missing object fails; nothing is repaired or published. Credentials are read
 * by `wrangler` from the environment and are never printed.
 *
 * Usage:
 *   tsx scripts/runtime-release-preflight.ts --descriptor <file.json> [--bucket <name>] [--local|--remote] [--persist-to <dir>]
 *   tsx scripts/runtime-release-preflight.ts --descriptor-sha256 <hex> [--bucket <name>] [--local|--remote] [--persist-to <dir>]
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  RUNTIME_ARTIFACT_OBJECT_PREFIX,
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
} from '../src/sandbox-control/runtime-artifact-store.js';
import { RUNTIME_DISTRIBUTION } from '../src/shared/runtime-distribution.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  parseRuntimeRelease,
  runtimeArtifactForRole,
} from '../src/shared/runtime-release.js';

const exec = promisify(execFile);
const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export type Check = { name: string; passed: boolean; detail: string };
/** Read one object's bytes, or null when the key is absent. */
export type PreflightReader = (key: string) => Promise<Uint8Array | null>;

type Options = {
  descriptorPath?: string;
  descriptorSha256?: string;
  bucket: string;
  remote: boolean;
  persistTo?: string;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { bucket: 'kilocode-cloud-agent-releases-dev', remote: false };
  const valueFlags: Record<string, (value: string) => void> = {
    '--descriptor': value => (options.descriptorPath = value),
    '--descriptor-sha256': value => (options.descriptorSha256 = value),
    '--bucket': value => (options.bucket = value),
    '--persist-to': value => (options.persistTo = value),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === '--remote') {
      options.remote = true;
      continue;
    }
    if (flag === '--local') {
      options.remote = false;
      continue;
    }
    const handler = valueFlags[flag];
    if (!handler) throw new Error(`unknown argument ${arg}`);
    const value = eq === -1 ? argv[(index += 1)] : arg.slice(eq + 1);
    if (value === undefined) throw new Error(`${flag} requires a value`);
    handler(value);
  }
  if (!options.descriptorPath && !options.descriptorSha256) {
    throw new Error('one of --descriptor or --descriptor-sha256 is required');
  }
  return options;
}

async function readObject(options: Options, key: string): Promise<Uint8Array | null> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'runtime-preflight-'));
  const file = path.join(dir, 'object.bin');
  const flags = options.remote ? ['--remote'] : ['--local'];
  if (options.persistTo) flags.push('--persist-to', options.persistTo);
  try {
    await exec(
      'pnpm',
      [
        'exec',
        'wrangler',
        'r2',
        'object',
        'get',
        `${options.bucket}/${key}`,
        `--file=${file}`,
        ...flags,
      ],
      { cwd: SERVICE_ROOT }
    );
    return fs.existsSync(file) ? new Uint8Array(await fsPromises.readFile(file)) : null;
  } catch (error) {
    const detail = `${(error as { stderr?: string }).stderr ?? ''}${(error as Error).message ?? ''}`;
    if (/specified key does not exist|nosuchkey|\b404\b/i.test(detail)) return null;
    throw error;
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Descriptor and object checks. Pure apart from the injected reader, so the
 * logic is testable without a bucket.
 */
export async function verifyRelease(
  descriptorBytes: Uint8Array,
  options: { descriptorSha256?: string; read: PreflightReader }
): Promise<Check[]> {
  const checks: Check[] = [];
  const descriptorSha256 = sha256(descriptorBytes);

  checks.push({
    name: 'descriptor is within the launch byte cap',
    passed: descriptorBytes.byteLength <= RUNTIME_DESCRIPTOR_MAX_BYTES,
    detail: `${descriptorBytes.byteLength} <= ${RUNTIME_DESCRIPTOR_MAX_BYTES}`,
  });
  if (options.descriptorSha256) {
    checks.push({
      name: 'descriptor matches the requested evidence hash',
      passed: descriptorSha256 === options.descriptorSha256,
      detail: `${descriptorSha256} == ${options.descriptorSha256}`,
    });
  }

  let descriptor: ReturnType<typeof parseRuntimeRelease> | undefined;
  try {
    descriptor = parseRuntimeRelease(descriptorBytes);
    checks.push({
      name: 'descriptor parses against the release schema',
      passed: true,
      detail: 'ok',
    });
  } catch (error) {
    checks.push({
      name: 'descriptor parses against the release schema',
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (descriptor) {
    checks.push({
      name: 'descriptor declares the required base ABI',
      passed: descriptor.abi === RUNTIME_BASE_ABI,
      detail: `${descriptor.abi} == ${RUNTIME_BASE_ABI}`,
    });

    for (const role of ['cli', 'control'] as const) {
      const artifact = runtimeArtifactForRole(descriptor, role);
      const key = runtimeArtifactObjectKey(artifact.sha256);
      const bytes = await options.read(key);
      const sizeOk = bytes !== null && bytes.byteLength === artifact.transferBytes;
      const hashOk = bytes !== null && sha256(bytes) === artifact.sha256;
      checks.push({
        name: `${role} artifact object matches its declared size and hash`,
        passed: sizeOk && hashOk,
        detail:
          bytes === null
            ? `${key}: not published`
            : `${key}: size=${bytes.byteLength}/${artifact.transferBytes} hash=${hashOk}`,
      });
    }

    // The evidence object must exist and be byte-identical to the descriptor.
    const evidenceKey = runtimeArtifactReleaseKey(descriptorSha256);
    const evidenceBytes = await options.read(evidenceKey);
    checks.push({
      name: 'release evidence object exists and matches the descriptor',
      passed: evidenceBytes !== null && sha256(evidenceBytes) === descriptorSha256,
      detail: `${evidenceKey}${evidenceBytes === null ? ': not published' : ''}`,
    });
    checks.push({
      name: 'artifact keys use the shared object prefix',
      passed: runtimeArtifactObjectKey(descriptor.artifacts[0].sha256).startsWith(
        RUNTIME_ARTIFACT_OBJECT_PREFIX
      ),
      detail: RUNTIME_ARTIFACT_OBJECT_PREFIX,
    });
  }

  return checks;
}

export function checkRuntimeFreeBase(serviceRoot = SERVICE_ROOT): Check[] {
  const checks: Check[] = [];
  const read = (relative: string): string =>
    fs.readFileSync(path.join(serviceRoot, relative), 'utf8');
  const runtimeFree = read('Dockerfile.runtime-free');
  const dev = read('Dockerfile.dev');
  const containers = read('Dockerfile.containers');
  const packageJson = JSON.parse(read('package.json')) as { dependencies: Record<string, string> };
  const sandboxVersion = packageJson.dependencies['@cloudflare/sandbox'];

  const from = `FROM docker.io/cloudflare/sandbox:${sandboxVersion} AS generic-tools`;
  checks.push({
    name: 'runtime-free base is the generic-tools stage of the sandbox base',
    passed: runtimeFree.includes(from) && dev.includes(from),
    detail: from,
  });
  checks.push({
    name: 'runtime-free carries no baked Kilo CLI',
    passed: !runtimeFree.includes('@kilocode/cli'),
    detail: 'no @kilocode/cli install',
  });
  checks.push({
    name: 'runtime-free carries no built control wrapper',
    passed: !runtimeFree.includes('bun run build.ts --install-dir'),
    detail: 'no wrapper build',
  });
  checks.push({
    name: 'runtime-free pins the compatible base Bun from the shared owner',
    passed:
      runtimeFree.includes('ARG BUN_VERSION') &&
      runtimeFree.includes('FROM oven/bun:${BUN_VERSION}') &&
      !/ARG BUN_VERSION=/.test(runtimeFree),
    detail: `oven/bun:\${BUN_VERSION} (RUNTIME_DISTRIBUTION.bun=${RUNTIME_DISTRIBUTION.bun})`,
  });
  checks.push({
    name: 'runtime-free pins the shared pnpm and glab toolchain',
    passed:
      runtimeFree.includes(`ARG PNPM_VERSION="${RUNTIME_DISTRIBUTION.pnpm}"`) &&
      runtimeFree.includes(`ARG GLAB_VERSION="${RUNTIME_DISTRIBUTION.glab}"`),
    detail: `pnpm=${RUNTIME_DISTRIBUTION.pnpm} glab=${RUNTIME_DISTRIBUTION.glab}`,
  });
  checks.push({
    name: 'native base pins the tested Bun and pnpm',
    passed:
      containers.includes(`ARG BUN_VERSION="${RUNTIME_DISTRIBUTION.bun}"`) &&
      containers.includes(`ARG PNPM_VERSION="${RUNTIME_DISTRIBUTION.pnpm}"`),
    detail: `bun=${RUNTIME_DISTRIBUTION.bun} pnpm=${RUNTIME_DISTRIBUTION.pnpm}`,
  });
  return checks;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let descriptorBytes: Uint8Array;
  if (options.descriptorPath) {
    descriptorBytes = new Uint8Array(await fsPromises.readFile(options.descriptorPath));
  } else {
    const requestedSha256 = options.descriptorSha256;
    if (requestedSha256 === undefined) {
      throw new Error('one of --descriptor or --descriptor-sha256 is required');
    }
    const evidence = await readObject(options, runtimeArtifactReleaseKey(requestedSha256));
    if (evidence === null) {
      throw new Error(`release evidence ${requestedSha256} is not published`);
    }
    descriptorBytes = evidence;
  }

  const checks = [
    ...(await verifyRelease(descriptorBytes, {
      descriptorSha256: options.descriptorSha256,
      read: key => readObject(options, key),
    })),
    ...checkRuntimeFreeBase(),
  ];

  for (const check of checks) {
    console.log(`${check.passed ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  const summary = {
    bucket: options.bucket,
    target: options.remote ? 'remote' : 'local',
    descriptorSha256: sha256(descriptorBytes),
    descriptorBytes: descriptorBytes.byteLength,
    passed: checks.filter(check => check.passed).length,
    failed: checks.filter(check => !check.passed).length,
  };
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
