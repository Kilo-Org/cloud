import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  RUNTIME_DISTRIBUTION,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from '../src/shared/runtime-distribution.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
} from '../src/shared/runtime-release.js';
import { controlBundleEntries, packageRuntimeRelease, sha256 } from './publish-runtime.js';
import { downloadVerified, PINNED_CLI_SHA256 } from './runtime-cli-artifact.js';
import {
  collectRuntimeInputs,
  nativeBaseInputSha256,
  NATIVE_RUNTIME_FREE_DOCKERFILE,
} from './runtime-ci-inputs.js';
import { remoteArtifactStore } from './runtime-ci-store.js';
import {
  baseEvidenceSchema,
  prepareCandidateRelease,
  releaseBundleSchema,
  selectReleaseTarget,
  sourceShaSchema,
  verifyPublishedRuntime,
  verifyReleaseBundle,
} from './runtime-ci-release.js';
import {
  assertDeployedSourceOrder,
  cloudflareAPI,
  registryDigest,
  verifyManagedBase,
} from './runtime-ci-cloudflare.js';

const SERVICE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);

async function readCommand(program: string, args: string[], cwd = SERVICE_ROOT) {
  try {
    return (
      await exec(program, args, { cwd, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trim();
  } catch {
    throw new Error(`${program} ${args[0]} release command failed`);
  }
}

async function runTool(program: string, args: string[], cwd = SERVICE_ROOT) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'inherit', timeout: 20 * 60_000 });
    child.on('error', () => reject(new Error(`${program} ${args[0]} could not start`)));
    child.on('close', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${program} ${args[0]} failed (${signal ?? `exit ${code}`})`))
    );
  });
}

export async function nativeBaseChanged(
  serviceRoot: string,
  baseline: string,
  currentSha256: string
) {
  if (!baseline) return true;
  sourceShaSchema.parse(baseline);
  try {
    const recipe = await readCommand(
      'git',
      ['show', `${baseline}:services/cloud-agent-next/${NATIVE_RUNTIME_FREE_DOCKERFILE}`],
      serviceRoot
    );
    const releaseSource = await readCommand(
      'git',
      ['show', `${baseline}:services/cloud-agent-next/src/shared/runtime-release.ts`],
      serviceRoot
    );
    const abi = releaseSource.match(/export const RUNTIME_BASE_ABI = ['"]([^'"]+)['"]/u)?.[1];
    return abi === undefined || nativeBaseInputSha256(`${recipe}\n`, abi) !== currentSha256;
  } catch {
    return true;
  }
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the CI release`);
  return value;
}

export function assertTrustedRuntimeCI(environment: NodeJS.ProcessEnv) {
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_REF !== 'refs/heads/main' ||
    !['schedule', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME ?? '')
  ) {
    throw new Error(
      'runtime publication and deployment require trusted main CI; local and PR release execution is prohibited'
    );
  }
}

async function buildNativeBase(serviceRoot: string, tag: string) {
  const context = await fs.mkdtemp(path.join(os.tmpdir(), 'kilo-native-base-'));
  try {
    await fs.copyFile(
      path.join(serviceRoot, NATIVE_RUNTIME_FREE_DOCKERFILE),
      path.join(context, 'Dockerfile')
    );
    await runTool(
      'docker',
      ['build', '--platform', 'linux/amd64', '--tag', tag, context],
      serviceRoot
    );
    const absent = [
      ...WRAPPER_BUNDLES.map(bundle => runtimeInstallPath(bundle.installName)),
      '/usr/local/bin/kilo',
      '/usr/local/lib/node_modules/@kilocode',
      runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName),
      GIT_CREDENTIAL_HELPER.realPath,
      GIT_CREDENTIAL_HELPER.linkPath,
    ];
    const smoke = [
      'set -eu',
      ...absent.map(file => `test ! -e '${file}'`),
      `test "$(bun --version)" = '${RUNTIME_DISTRIBUTION.bun}'`,
      `test "$(pnpm --version)" = '${RUNTIME_DISTRIBUTION.pnpm}'`,
      `case "$(node --version)" in v${RUNTIME_DISTRIBUTION.nodeMajor}.*) ;; *) exit 1 ;; esac`,
      `case "$(gh --version)" in 'gh version ${RUNTIME_DISTRIBUTION.gh}'*) ;; *) exit 1 ;; esac`,
      `case "$(glab --version)" in 'glab ${RUNTIME_DISTRIBUTION.glab}'*) ;; *) exit 1 ;; esac`,
      'git --version',
      'git-lfs --version',
      'rg --version',
    ].join('; ');
    await runTool(
      'docker',
      ['run', '--rm', '--platform', 'linux/amd64', '--entrypoint', '/bin/sh', tag, '-c', smoke],
      serviceRoot
    );
  } finally {
    await fs.rm(context, { recursive: true, force: true });
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!['validate', 'check-base', 'prepare', 'verify'].includes(command))
    throw new Error('expected validate, check-base, prepare, or verify');
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !['--environment', '--source-sha', '--out', '--base-sha'].includes(name) ||
      value === undefined
    )
      throw new Error('invalid runtime CI argument');
    values.set(name, value);
  }
  const inputs = await collectRuntimeInputs(SERVICE_ROOT);
  const configSource = await fs.readFile(path.join(SERVICE_ROOT, 'wrangler.jsonc'), 'utf8');
  const environment = values.get('--environment') ?? 'production';
  const target = selectReleaseTarget(configSource, environment);
  if (command === 'validate') {
    const baseChanged = await nativeBaseChanged(
      SERVICE_ROOT,
      values.get('--base-sha') ?? '',
      inputs.baseSha256
    );
    if (process.env.GITHUB_OUTPUT)
      await fs.appendFile(process.env.GITHUB_OUTPUT, `base_changed=${baseChanged}\n`);
    console.log(JSON.stringify({ ...inputs, mode: 'candidate' }));
    return;
  }
  if (command === 'check-base') {
    await buildNativeBase(SERVICE_ROOT, `kilo-native-base-check:${inputs.baseSha256.slice(0, 12)}`);
    console.log('Native runtime-free candidate passed the local image contract check');
    return;
  }
  assertTrustedRuntimeCI(process.env);
  const sourceSha = sourceShaSchema.parse(values.get('--source-sha'));
  if ((await readCommand('git', ['rev-parse', 'HEAD'])) !== sourceSha)
    throw new Error('deployment checkout does not match the admitted source SHA');
  const directory = path.resolve(SERVICE_ROOT, values.get('--out') ?? '.wrangler/runtime-release');
  const api = cloudflareAPI(target.accountId, requiredEnv('CLOUDFLARE_API_TOKEN'));
  const store = remoteArtifactStore({
    accountId: target.accountId,
    bucket: target.bucket,
    accessKeyId: requiredEnv('CLOUD_AGENT_RUNTIME_R2_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnv('CLOUD_AGENT_RUNTIME_R2_SECRET_ACCESS_KEY'),
  });
  if (command === 'prepare') {
    const prepared = await prepareCandidateRelease({
      store,
      inputs,
      packageRuntime: async () => {
        if ((await readCommand('bun', ['--version'])) !== RUNTIME_DISTRIBUTION.bun)
          throw new Error('CI Bun does not match the runtime build contract');
        await runTool('pnpm', ['run', 'build:wrapper']);
        const cliTarball = await downloadVerified(inputs.cliVersion);
        if (sha256(cliTarball) !== PINNED_CLI_SHA256)
          throw new Error('CLI tarball differs from its reviewed SHA-256 pin');
        return packageRuntimeRelease({
          cliTarball,
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
          controlEntries: await controlBundleEntries(SERVICE_ROOT),
        });
      },
      buildBase: async () => {
        const runId = z.string().regex(/^\d+$/).parse(requiredEnv('GITHUB_RUN_ID'));
        const attempt = z.string().regex(/^\d+$/).parse(requiredEnv('GITHUB_RUN_ATTEMPT'));
        const tag = `cloud-agent-runtime-base:${inputs.baseSha256.slice(0, 12)}-${runId}-${attempt}`;
        await buildNativeBase(SERVICE_ROOT, tag);
        await runTool('pnpm', ['exec', 'wrangler', 'containers', 'push', tag]);
        const reference = `registry.cloudflare.com/${target.accountId}/${tag}`;
        const digest = await registryDigest(target.accountId, reference, api);
        return baseEvidenceSchema.parse({
          format: 'kilo-native-base-v1',
          inputSha256: inputs.baseSha256,
          sourceSha,
          platform: 'linux/amd64',
          abi: RUNTIME_BASE_ABI,
          image: `${reference.split(':')[0]}@${digest}`,
        });
      },
      verifyBase: base => verifyManagedBase(base, target.accountId, api),
    });
    const bundle = releaseBundleSchema.parse({
      format: 'kilo-runtime-ci-v1',
      mode: 'candidate',
      sourceSha,
      environment,
      accountId: target.accountId,
      bucket: target.bucket,
      configSha256: sha256(new TextEncoder().encode(configSource)),
      runtimeInputSha256: inputs.runtimeSha256,
      descriptorSha256: prepared.descriptorSha256,
      base: prepared.base,
    });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'release.json'), JSON.stringify(bundle));
    await fs.writeFile(path.join(directory, 'descriptor.json'), prepared.descriptorBytes);
    console.log(
      JSON.stringify({
        sourceSha,
        environment,
        runtimeReused: prepared.runtimeReused,
        baseReused: prepared.baseReused,
        descriptorSha256: prepared.descriptorSha256,
        baseImage: prepared.base.image,
        mode: 'candidate',
      })
    );
    return;
  }
  const bundle = releaseBundleSchema.parse(
    JSON.parse(await fs.readFile(path.join(directory, 'release.json'), 'utf8'))
  );
  const descriptorBytes = new Uint8Array(
    await fs.readFile(path.join(directory, 'descriptor.json'))
  );
  const config = verifyReleaseBundle(bundle, {
    sourceSha,
    environment,
    configSource,
    inputs,
    descriptorBytes,
  });
  await verifyPublishedRuntime(store, descriptorBytes, bundle.descriptorSha256, inputs);
  await verifyManagedBase(bundle.base, target.accountId, api);
  await assertDeployedSourceOrder({
    workerName: target.workerName,
    sourceSha,
    api,
    isAncestor: async (older, newer) => {
      try {
        await exec('git', ['merge-base', '--is-ancestor', older, newer], { cwd: SERVICE_ROOT });
        return true;
      } catch {
        return false;
      }
    },
  });
  await fs.writeFile(
    path.join(SERVICE_ROOT, 'wrangler.runtime-release.json'),
    JSON.stringify(config)
  );
  console.log(`Verified candidate release for ${sourceSha}; production launch remains baked`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'runtime CI release failed');
    process.exitCode = 1;
  });
}
