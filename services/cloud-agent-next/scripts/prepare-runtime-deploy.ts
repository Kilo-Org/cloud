import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import {
  runtimeStartupConfigSchema,
  type RuntimeStartupConfig,
} from '../src/shared/runtime-startup-config.js';
import { verifyRuntimeSourceCheckout } from './runtime-source.js';
import { remoteArtifactStore } from './runtime-publish-store.js';
import { loadRuntimeHandoff, runtimeHandoffKey } from './runtime-handoff.js';
import { probePublication } from './runtime-publication-runs.js';
import {
  runtimeBaseInputId,
  verifyRuntimeBase,
  withRuntimeRegistry,
  type RuntimeBase,
} from './runtime-base.js';
import {
  selectRuntimeTarget,
  renderRuntimeTarget,
  validateRuntimeTarget,
  runtimeBucketBindings,
} from './runtime-target.js';

/** Validate references and render JSON. */
export async function prepareRuntimeDeployment(input: {
  config: unknown;
  environment: string;
  startup: RuntimeStartupConfig;
  sourceSha: string;
  bucket: string;
  accountId: string;
  baseInputId: string;
  store: ArtifactObjectStore;
  verifyBase: (base: RuntimeBase) => void | Promise<void>;
}) {
  const startup = runtimeStartupConfigSchema.parse(input.startup);
  if (startup.mode === 'preinstalled')
    return renderRuntimeTarget({ config: input.config, environment: input.environment, startup });
  const { target } = validateRuntimeTarget(input.config, input.environment);
  runtimeBucketBindings(target.r2_buckets, input.bucket);
  const { handoff } = await loadRuntimeHandoff(input.store, input.sourceSha, input.baseInputId);
  if (!handoff.base.image.startsWith('registry.cloudflare.com/' + input.accountId + '/'))
    throw new Error('Runtime handoff belongs to another account');
  const config = renderRuntimeTarget({
    config: input.config,
    environment: input.environment,
    startup,
    release: {
      descriptorSha256: handoff.descriptorSha256,
      ...(handoff.kilo2DescriptorSha256 === undefined
        ? {}
        : { kilo2DescriptorSha256: handoff.kilo2DescriptorSha256 }),
      baseImage: handoff.base.image,
      bucket: input.bucket,
    },
  });
  await input.verifyBase(handoff.base);
  return config;
}

const HANDOFF_WAIT_MS = 45 * 60_000;
const HANDOFF_POLL_MS = 5_000;
const PUBLICATION_PROBE_MS = 30_000;

/**
 * Wait for the exact-SHA handoff. When the publication can no longer produce it, fail with the
 * probe's reason instead of holding the deployment for the full wait.
 */
export async function waitForRuntimeHandoff(
  store: ArtifactObjectStore,
  sourceSha: string,
  probe?: (waitedMs: number) => Promise<string | null>
): Promise<void> {
  const key = runtimeHandoffKey(sourceSha);
  const started = Date.now();
  let probedAt = Number.NEGATIVE_INFINITY;
  while ((await store.getBytes(key)) === null) {
    const waitedMs = Date.now() - started;
    if (waitedMs > HANDOFF_WAIT_MS)
      throw new Error(
        `Exact-SHA runtime publication did not complete within ${HANDOFF_WAIT_MS / 60_000} minutes`
      );
    if (probe && Date.now() - probedAt >= PUBLICATION_PROBE_MS) {
      probedAt = Date.now();
      const failure = await probe(waitedMs);
      if (failure) {
        // The publication may have written the handoff just before its run completed.
        if ((await store.getBytes(key)) !== null) return;
        throw new Error(failure);
      }
    }
    await new Promise(resolve => setTimeout(resolve, HANDOFF_POLL_MS));
  }
}

async function writeDeploymentConfig(packageRoot: string, environment: string, config: unknown) {
  await fs.writeFile(
    path.join(packageRoot, 'wrangler.runtime-generated.json'),
    JSON.stringify(config)
  );
  if (process.env.GITHUB_OUTPUT)
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      'command=deploy --config wrangler.runtime-generated.json' +
        (environment === 'production'
          ? ''
          : ' --env ' +
            z
              .string()
              .regex(/^[a-z0-9-]+$/)
              .parse(environment)) +
        '\n'
    );
}
export async function main(
  argv = process.argv.slice(2),
  packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
) {
  const [environment, sourceSha] = argv;
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(sourceSha);
  verifyRuntimeSourceCheckout(sourceSha, packageRoot);
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(
    await fs.readFile(path.join(packageRoot, 'wrangler.jsonc'), 'utf8'),
    errors,
    { allowTrailingComma: true }
  );
  if (errors.length > 0) throw new Error('Invalid wrangler.jsonc syntax');
  const startup = selectRuntimeTarget(
    JSON.parse(await fs.readFile(path.join(packageRoot, 'runtime-targets.json'), 'utf8')),
    environment
  );
  const { target } = validateRuntimeTarget(raw, environment);
  if (startup.mode === 'preinstalled') {
    await writeDeploymentConfig(
      packageRoot,
      environment,
      renderRuntimeTarget({ config: raw, environment, startup })
    );
    return; // No publication storage request, registry access or publisher credentials.
  }
  const accountId = z.string().parse(process.env.RUNTIME_R2_ACCOUNT_ID);
  const bucket = z.string().parse(process.env.RUNTIME_R2_BUCKET);
  runtimeBucketBindings(target.r2_buckets, bucket);
  const baseInputId = await runtimeBaseInputId(packageRoot);
  const store = remoteArtifactStore({
    accountId,
    bucket,
    accessKeyId: z.string().parse(process.env.RUNTIME_R2_ACCESS_KEY_ID),
    secretAccessKey: z.string().parse(process.env.RUNTIME_R2_SECRET_ACCESS_KEY),
  });
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  await waitForRuntimeHandoff(
    store,
    sourceSha,
    token && repository
      ? async waitedMs => {
          try {
            return await probePublication(sourceSha, repository, token, waitedMs);
          } catch (error) {
            console.warn('Runtime publication status is unavailable; still waiting', error);
            return null;
          }
        }
      : undefined
  );
  await withRuntimeRegistry(packageRoot, async () => {
    const config = await prepareRuntimeDeployment({
      config: raw,
      environment,
      startup,
      sourceSha,
      bucket,
      accountId,
      baseInputId,
      store,
      verifyBase: base => verifyRuntimeBase(base, packageRoot),
    });
    await writeDeploymentConfig(packageRoot, environment, config);
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
