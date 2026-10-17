#!/usr/bin/env bun
/**
 * Personal runtime candidate tooling (plan §5) — command execution.
 *
 * Every real command (git, bun, pnpm, wrangler, R2) runs through this module.
 * It is intentionally small: the reviewable contract lives in
 * `runtime-personal-candidate.ts`, and command wiring lives here.
 *
 * Two-phase admission:
 *   prepare --source-sha <sha> --feature-branch <branch>
 *       materializes a clean detached feature worktree under the primary repo,
 *       installs with a frozen lockfile, preserves it, and prints NOT SEALED
 *       with the exact next command. Dirty helper code is never copied.
 *   prepare --checkout <worktree> ...
 *       must run from inside that checkout (module and CWD both inside it); it
 *       builds the candidate there.
 *
 * `verify` reads the EXISTING candidate config/source/toolchain first, refuses
 * drift without overwriting anything, then rebuilds the bundle on that same
 * config and compares bytes. `render` requires a sealed record, verifies it,
 * and returns the sealed config path; there is no raw descriptor/image render.
 * No verb deploys.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { parse as parseJsonc } from 'jsonc-parser';

import { runtimeArtifactReleaseKey } from '../src/sandbox-control/runtime-artifact-store.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  parseRuntimeRelease,
  runtimeArtifactForRole,
  serializeRuntimeRelease,
} from '../src/shared/runtime-release.js';
import {
  controlBundleEntries,
  packageRuntimeRelease,
  publishRuntimeRelease,
  sha256,
} from './publish-runtime.js';
import { downloadVerified, PINNED_CLI_SHA256 } from './runtime-cli-artifact.js';
import { collectRuntimeInputs } from './runtime-ci-inputs.js';
import { verifyPublishedRuntime } from './runtime-ci-release.js';
import { cloudflareAPI, verifyManagedBase } from './runtime-ci-cloudflare.js';
import { remoteArtifactStore } from './runtime-ci-store.js';
import {
  DEFAULT_PERSONAL_CONFIG_PATH,
  PERSONAL_WRANGLER_CONFIG_NAME,
  assertAdmittedSource,
  assertFeatureSource,
  admitTrustedNativeBase,
  assertExplicitNativeConfig,
  parseSealedCandidateRecord,
  personalArtifactStore,
  personalCandidateKey,
  personalRuntimeEvidenceKey,
  publishPersonalProvenance,
  readSourceFacts,
  readToolchain,
  renderPersonalCandidateConfig,
  resolveBuildContext,
  sealCandidateRecord,
  selectPersonalTarget,
  verifySealedCandidate,
  type CandidateContext,
  type CommandRunner,
  type PersonalTarget,
} from './runtime-personal-candidate.js';

const exec = promisify(execFile);
const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_PATH = fileURLToPath(import.meta.url);

type Command = 'prepare' | 'verify' | 'render';

type CliOptions = {
  command: Command;
  sourceSha?: string;
  featureBranch?: string;
  checkout?: string;
  record?: string;
  personalConfig?: string;
  origin?: string;
  bucket?: string;
  outDir: string;
};

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: 'prepare',
    outDir: path.join(SERVICE_ROOT, '.wrangler', 'personal-candidate'),
  };
  const valueFlags: Record<string, (value: string) => void> = {
    '--source-sha': value => (options.sourceSha = value),
    '--feature-branch': value => (options.featureBranch = value),
    '--checkout': value => (options.checkout = value),
    '--record': value => (options.record = value),
    '--personal-config': value => (options.personalConfig = value),
    '--origin': value => (options.origin = value),
    '--bucket': value => (options.bucket = value),
    '--out': value => (options.outDir = path.resolve(value)),
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
      if (arg !== 'prepare' && arg !== 'verify' && arg !== 'render')
        throw new Error('unsupported personal candidate argument');
      rest.push(arg);
    }
  }
  if (rest.length === 1 && (rest[0] === 'prepare' || rest[0] === 'verify' || rest[0] === 'render'))
    options.command = rest[0];
  else throw new Error('expected one of: prepare, verify, render (deployment is refused)');
  return options;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

const realRunner: CommandRunner = async (program, args, options) => {
  const result = await exec(program, args, {
    cwd: options?.cwd,
    timeout: 30 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
  });
  return { stdout: String(result.stdout) };
};

function repoRootOf(serviceRoot: string): string {
  return path.resolve(serviceRoot, '../..');
}

export function personalCheckoutPath(repoRoot: string, featureBranch: string): string {
  const slug = featureBranch.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return path.join(
    path.dirname(repoRoot),
    '.cloud-agent-runtime-candidates',
    path.basename(repoRoot),
    slug
  );
}

function inside(child: string, parent: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  return (
    resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`)
  );
}

/** Assert the helper module and CWD are both inside the admitted checkout. */
export function assertRunningFromCheckout(checkoutRoot: string): void {
  if (!inside(MODULE_PATH, checkoutRoot))
    throw new Error(
      'refusing to build: the helper module is not running from the admitted checkout'
    );
  if (!inside(process.cwd(), checkoutRoot))
    throw new Error('refusing to build: the working directory is not inside the admitted checkout');
}

async function hashDirectory(dir: string): Promise<string> {
  const entries: [string, Uint8Array][] = [];
  const walk = async (current: string): Promise<void> => {
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name);
      if (item.isDirectory()) await walk(absolute);
      else
        entries.push([path.relative(dir, absolute), new Uint8Array(await fs.readFile(absolute))]);
    }
  };
  await walk(dir);
  entries.sort(([left], [right]) => left.localeCompare(right));
  const parts: Buffer[] = [];
  for (const [relative, bytes] of entries)
    parts.push(Buffer.from(`${relative}\0`), Buffer.from(bytes));
  return sha256(Buffer.concat(parts));
}

type ContextDeps = {
  runner: CommandRunner;
  checkoutRoot: string;
  serviceRoot: string;
  branch: string;
  sourceSha: string;
  store: ReturnType<typeof personalArtifactStore>;
  target: PersonalTarget;
};

async function inspectContext(
  deps: ContextDeps,
  configPath: string,
  descriptorSha256: string
): Promise<CandidateContext> {
  const source = await readSourceFacts(deps.runner, deps.checkoutRoot, deps.branch);
  assertAdmittedSource(source, deps.sourceSha);
  const toolchain = await readToolchain(deps.runner, deps.checkoutRoot, absolute =>
    fs.readFile(absolute)
  );
  const inputs = await collectRuntimeInputs(deps.serviceRoot);
  const configBytes = new Uint8Array(await fs.readFile(configPath));
  const configSha256 = sha256(configBytes);
  const config: unknown = parseJsonc(new TextDecoder().decode(configBytes));
  const buildContext = await resolveBuildContext(configPath, config, {
    read: absolute => fs.readFile(absolute),
    className: deps.target.className,
    admittedRoot: deps.serviceRoot,
  });
  const outdir = path.join(path.dirname(configPath), 'bundle');
  await fs.rm(outdir, { recursive: true, force: true });
  await deps.runner(
    'pnpm',
    ['exec', 'wrangler', 'deploy', '--dry-run', '--outdir', outdir, '--config', configPath],
    { cwd: deps.serviceRoot }
  );
  const bundleSha256 = await hashDirectory(outdir);
  const releaseBytes = await deps.store.getBytes(runtimeArtifactReleaseKey(descriptorSha256));
  if (releaseBytes === null)
    throw new Error('the sealed release evidence is missing from the trusted index');
  if (sha256(releaseBytes) !== descriptorSha256)
    throw new Error('release evidence conflicts with the sealed descriptor hash');
  const descriptor = parseRuntimeRelease(releaseBytes);
  const base = await admitTrustedNativeBase({
    store: deps.store,
    baseSha256: inputs.baseSha256,
    accountId: deps.target.accountId,
    verify: async evidence => {
      const token = requiredEnv('CLOUDFLARE_API_TOKEN');
      await verifyManagedBase(
        evidence,
        deps.target.accountId,
        cloudflareAPI(deps.target.accountId, token)
      );
    },
  });
  return {
    source: { ...source, expectedSha: deps.sourceSha },
    inputs: {
      runtimeSha256: inputs.runtimeSha256,
      baseSha256: inputs.baseSha256,
      cliVersion: inputs.cliVersion,
      wrapperSdkVersion: inputs.wrapperSdkVersion,
    },
    toolchain,
    descriptorSha256,
    artifacts: {
      cliSha256: runtimeArtifactForRole(descriptor, 'cli').sha256,
      controlSha256: runtimeArtifactForRole(descriptor, 'control').sha256,
    },
    bundleSha256,
    base,
    target: deps.target,
    configPath,
    configSha256,
    buildContext,
  };
}

async function materializePhase(options: CliOptions): Promise<void> {
  const sourceSha = required(options.sourceSha, '--source-sha');
  const branch = required(options.featureBranch, '--feature-branch');
  const repoRoot = repoRootOf(SERVICE_ROOT);
  assertFeatureSource(await readSourceFacts(realRunner, repoRoot, branch), sourceSha);
  const checkoutRoot = personalCheckoutPath(repoRoot, branch);
  if (await fs.stat(checkoutRoot).catch(() => null))
    throw new Error(
      `the personal checkout already exists: ${checkoutRoot}; remove it explicitly to re-admit`
    );
  await realRunner('git', ['worktree', 'add', '--detach', checkoutRoot, sourceSha], {
    cwd: repoRoot,
  });
  await realRunner('pnpm', ['install', '--frozen-lockfile'], { cwd: checkoutRoot });
  console.log(
    JSON.stringify(
      {
        sealed: false,
        checkout: checkoutRoot,
        next: `cd ${checkoutRoot} && pnpm --filter cloud-agent-next exec tsx scripts/runtime-personal-candidate-cli.ts prepare --source-sha ${sourceSha} --feature-branch ${branch} --checkout ${checkoutRoot} --origin <https-origin>`,
        note: 'prepare the personal config at services/cloud-agent-next/.wrangler/personal/wrangler.jsonc, then run the printed command',
      },
      null,
      2
    )
  );
}

export async function runPrepareFromCheckout(options: CliOptions): Promise<void> {
  const checkoutRoot = required(options.checkout, '--checkout');
  assertRunningFromCheckout(checkoutRoot);
  const sourceSha = required(options.sourceSha, '--source-sha');
  const branch = required(options.featureBranch, '--feature-branch');
  const serviceRoot = path.join(checkoutRoot, 'services', 'cloud-agent-next');
  const origin = required(options.origin, '--origin');

  const committedSource = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
  const operatorPath = path.join(
    serviceRoot,
    options.personalConfig ?? DEFAULT_PERSONAL_CONFIG_PATH
  );
  const operatorSource = await fs.readFile(operatorPath, 'utf8');
  const target = selectPersonalTarget(operatorSource, committedSource, {
    origin,
    bucket: options.bucket,
  });

  const store = personalArtifactStore(
    remoteArtifactStore({
      accountId: target.accountId,
      bucket: target.bucket,
      accessKeyId: requiredEnv('CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY'),
    })
  );
  const deps: ContextDeps = {
    runner: realRunner,
    checkoutRoot,
    serviceRoot,
    branch,
    sourceSha,
    store,
    target,
  };

  const source = await readSourceFacts(realRunner, checkoutRoot, branch);
  assertAdmittedSource(source, sourceSha);
  const inputs = await collectRuntimeInputs(serviceRoot);

  // Mandatory wrapper rebuild: never trust a pre-existing ignored `wrapper/dist`.
  await realRunner('pnpm', ['run', 'build:wrapper'], { cwd: serviceRoot });
  const cliBytes = await downloadVerified(inputs.cliVersion);
  if (sha256(cliBytes) !== PINNED_CLI_SHA256)
    throw new Error('the downloaded CLI does not match its reviewed SHA-256 pin');
  const packaged = await packageRuntimeRelease({
    cliTarball: cliBytes,
    cliVersion: inputs.cliVersion,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: inputs.wrapperSdkVersion,
    protocol: 'control-plane-v1',
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries: await controlBundleEntries(serviceRoot),
  });
  const descriptorBytes = serializeRuntimeRelease(packaged.descriptor);
  const descriptorSha256 = sha256(descriptorBytes);
  const apiToken = requiredEnv('CLOUDFLARE_API_TOKEN');
  const base = await admitTrustedNativeBase({
    store,
    baseSha256: inputs.baseSha256,
    accountId: target.accountId,
    verify: async evidence => {
      await verifyManagedBase(
        evidence,
        target.accountId,
        cloudflareAPI(target.accountId, apiToken)
      );
    },
  });

  await publishRuntimeRelease(store, packaged);
  await verifyPublishedRuntime(store, descriptorBytes, descriptorSha256, inputs);
  await publishPersonalProvenance(store, personalRuntimeEvidenceKey(inputs.runtimeSha256), {
    format: 'kilo-personal-runtime-inputs-v1',
    inputSha256: inputs.runtimeSha256,
    descriptorSha256,
  });

  const candidateConfig = renderPersonalCandidateConfig(parseJsonc(operatorSource), {
    descriptor: new TextDecoder().decode(descriptorBytes),
    target,
    image: base.image,
  });
  assertExplicitNativeConfig(candidateConfig, {
    descriptor: new TextDecoder().decode(descriptorBytes),
    target,
  });
  const candidateDir = path.dirname(operatorPath);
  const candidatePath = path.join(candidateDir, PERSONAL_WRANGLER_CONFIG_NAME);
  if (path.resolve(candidatePath) === path.resolve(operatorPath))
    throw new Error('the candidate output must not overwrite the operator-prepared config');
  await fs.mkdir(candidateDir, { recursive: true });
  await fs.writeFile(candidatePath, `${JSON.stringify(candidateConfig, null, 2)}\n`);
  await fs.mkdir(options.outDir, { recursive: true });
  await fs.writeFile(path.join(options.outDir, 'descriptor.json'), descriptorBytes);

  const context = await inspectContext(deps, candidatePath, descriptorSha256);
  const sealed = sealCandidateRecord({
    format: 'kilo-runtime-personal-candidate-v1',
    source: { sha: sourceSha, tree: source.treeSha, branch },
    inputs: {
      runtimeSha256: inputs.runtimeSha256,
      baseSha256: inputs.baseSha256,
      cliVersion: inputs.cliVersion,
      wrapperSdkVersion: inputs.wrapperSdkVersion,
    },
    toolchain: context.toolchain,
    descriptorSha256: context.descriptorSha256,
    artifacts: context.artifacts,
    bundle: { sha256: context.bundleSha256 },
    base: context.base,
    target,
    config: {
      path: path.resolve(candidatePath),
      sha256: context.configSha256,
      buildContext: context.buildContext,
    },
    status: 'VERIFIED',
  });
  await publishPersonalProvenance(store, personalCandidateKey(sealed.sha256), sealed.record);
  await fs.writeFile(path.join(options.outDir, 'candidate.json'), sealed.bytes);
  console.log(
    JSON.stringify(
      {
        sealed: true,
        recordSha256: sealed.sha256,
        configPath: candidatePath,
        status: sealed.record.status,
        note: 'verify reads the existing config first and rebuilds the bundle on it; render requires this record',
      },
      null,
      2
    )
  );
}

async function runVerify(options: CliOptions): Promise<void> {
  const checkoutRoot = required(options.checkout, '--checkout');
  assertRunningFromCheckout(checkoutRoot);
  const serviceRoot = path.join(checkoutRoot, 'services', 'cloud-agent-next');
  const recordPath = required(options.record, '--record');
  const sealed = parseSealedCandidateRecord(JSON.parse(await fs.readFile(recordPath, 'utf8')));
  const origin = required(options.origin, '--origin');
  const committedSource = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
  const operatorSource = await fs.readFile(
    path.join(serviceRoot, options.personalConfig ?? DEFAULT_PERSONAL_CONFIG_PATH),
    'utf8'
  );
  const target = selectPersonalTarget(operatorSource, committedSource, {
    origin,
    bucket: options.bucket,
  });
  const store = personalArtifactStore(
    remoteArtifactStore({
      accountId: target.accountId,
      bucket: target.bucket,
      accessKeyId: requiredEnv('CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY'),
    })
  );
  const deps: ContextDeps = {
    runner: realRunner,
    checkoutRoot,
    serviceRoot,
    branch: sealed.source.branch,
    sourceSha: sealed.source.sha,
    store,
    target,
  };
  // Read the EXISTING sealed config first; verify never renders or overwrites it.
  const context = await inspectContext(deps, sealed.config.path, sealed.descriptorSha256);
  verifySealedCandidate(sealed, context);
  console.log(JSON.stringify({ verified: true, configPath: sealed.config.path }));
}

async function runRender(options: CliOptions): Promise<void> {
  const checkoutRoot = required(options.checkout, '--checkout');
  assertRunningFromCheckout(checkoutRoot);
  const recordPath = required(options.record, '--record');
  const sealed = parseSealedCandidateRecord(JSON.parse(await fs.readFile(recordPath, 'utf8')));
  const serviceRoot = path.join(checkoutRoot, 'services', 'cloud-agent-next');
  const origin = required(options.origin, '--origin');
  const committedSource = await fs.readFile(path.join(serviceRoot, 'wrangler.jsonc'), 'utf8');
  const operatorSource = await fs.readFile(
    path.join(serviceRoot, options.personalConfig ?? DEFAULT_PERSONAL_CONFIG_PATH),
    'utf8'
  );
  const target = selectPersonalTarget(operatorSource, committedSource, {
    origin,
    bucket: options.bucket,
  });
  const store = personalArtifactStore(
    remoteArtifactStore({
      accountId: target.accountId,
      bucket: target.bucket,
      accessKeyId: requiredEnv('CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY'),
    })
  );
  const deps: ContextDeps = {
    runner: realRunner,
    checkoutRoot,
    serviceRoot,
    branch: sealed.source.branch,
    sourceSha: sealed.source.sha,
    store,
    target,
  };
  const context = await inspectContext(deps, sealed.config.path, sealed.descriptorSha256);
  verifySealedCandidate(sealed, context);
  console.log(
    JSON.stringify({
      sealedConfigPath: sealed.config.path,
      recordSha256: sha256(new TextEncoder().encode(JSON.stringify(sealed))),
    })
  );
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === 'prepare') {
    if (options.checkout === undefined) await materializePhase(options);
    else await runPrepareFromCheckout(options);
    return;
  }
  if (options.command === 'verify') await runVerify(options);
  else await runRender(options);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'personal candidate failed');
    process.exitCode = 1;
  });
}
