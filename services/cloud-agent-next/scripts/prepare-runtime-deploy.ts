import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import { selectStartup } from '../src/sandbox-control/startup-selection.js';
import { verifyRuntimeSourceCheckout } from './runtime-source.js';
import { remoteArtifactStore } from './runtime-publish-store.js';
import { loadRuntimeHandoff, runtimeHandoffKey } from './runtime-handoff.js';
import {
  runtimeBaseInputId,
  verifyRuntimeBase,
  withRuntimeRegistry,
  type RuntimeBase,
} from './runtime-base.js';

const configSchema = z
  .object({
    r2_buckets: z
      .array(z.object({ binding: z.string(), bucket_name: z.string() }).passthrough())
      .optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    containers: z
      .array(
        z
          .object({ class_name: z.string(), images: z.record(z.string(), z.unknown()).optional() })
          .passthrough()
      )
      .optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export function runtimeDeploymentConfig(raw: unknown, environment: string) {
  const root = configSchema.parse(raw);
  if (environment === 'production') return { root, target: root };
  const target = configSchema.parse(root.env?.[environment]);
  return { root, target };
}

export function runtimeDeploymentStartup(raw: unknown, environment: string) {
  const { target } = runtimeDeploymentConfig(raw, environment);
  const vars = target.vars ?? {};
  return selectStartup(
    {
      RUNTIME_STARTUP_MODE: z
        .enum(['preinstalled', 'downloaded'])
        .optional()
        .parse(vars.RUNTIME_STARTUP_MODE),
      NATIVE_RUNTIME_IMAGE: z
        .enum(['all-in-one', 'runtime-free'])
        .optional()
        .parse(vars.NATIVE_RUNTIME_IMAGE),
      RUNTIME_RELEASE_DESCRIPTOR:
        z.string().optional().parse(vars.RUNTIME_RELEASE_DESCRIPTOR) ?? 'pending handoff',
    },
    'cloudflare-containers'
  );
}

function runtimeDeploymentImage(
  target: ReturnType<typeof runtimeDeploymentConfig>['target'],
  image: string
) {
  const containers = target.containers;
  const native = containers?.find(container => container.class_name === 'SandboxContainers');
  if (!native || !native.images?.app)
    throw new Error('Downloaded target lacks its native app image');
  const configured = z
    .object({
      dockerfile: z.string().optional(),
      image: z.string().optional(),
      build_vars: z.record(z.string(), z.string()).optional(),
    })
    .strict()
    .parse(native.images.app);
  if (
    image === 'all-in-one' &&
    (configured.dockerfile !== './Dockerfile.containers' || configured.image !== undefined)
  )
    throw new Error('All-in-one target image configuration changed');
  if (
    image === 'runtime-free' &&
    configured.dockerfile !== './Dockerfile.containers.runtime-free' &&
    configured.image === undefined
  )
    throw new Error('Runtime-free target image configuration changed');
  return { native, configured };
}

/** Check the final target before Wrangler can run its custom build. */
export async function prepareRuntimeDeployment(input: {
  config: unknown;
  environment: string;
  sourceSha: string;
  bucket: string;
  accountId: string;
  baseInputId: string;
  store: ArtifactObjectStore;
  verifyBase: (base: RuntimeBase) => void | Promise<void>;
}) {
  const { root, target } = runtimeDeploymentConfig(input.config, input.environment);
  const vars = target.vars ?? {};
  const selection = runtimeDeploymentStartup(input.config, input.environment);
  if (selection.mode === 'preinstalled') return null;
  if (
    !target.r2_buckets?.some(
      binding =>
        binding.binding === 'RUNTIME_RELEASE_BUCKET' && binding.bucket_name === input.bucket
    )
  )
    throw new Error('Runtime target bucket binding changed');
  const { handoff } = await loadRuntimeHandoff(input.store, input.sourceSha, input.baseInputId);
  if (!handoff.base.image.startsWith('registry.cloudflare.com/' + input.accountId + '/'))
    throw new Error('Runtime handoff belongs to another account');
  const { native, configured } = runtimeDeploymentImage(target, selection.image);
  if (
    selection.image === 'runtime-free' &&
    configured.dockerfile !== './Dockerfile.containers.runtime-free' &&
    configured.image !== handoff.base.image
  )
    throw new Error('Runtime-free target image configuration changed');
  const descriptorHash = handoff.descriptorSha256;
  if (
    vars.RUNTIME_RELEASE_DESCRIPTOR !== undefined &&
    vars.RUNTIME_RELEASE_DESCRIPTOR !== descriptorHash
  )
    throw new Error('Target descriptor differs from its exact-SHA handoff');
  await input.verifyBase(handoff.base);
  target.vars = { ...vars, RUNTIME_RELEASE_DESCRIPTOR: descriptorHash };
  if (selection.image === 'runtime-free')
    native.images = { ...native.images, app: { image: handoff.base.image } };
  if (input.environment !== 'production') root.env = { ...root.env, [input.environment]: target };
  return root;
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
  const { target } = runtimeDeploymentConfig(raw, environment);
  const selection = runtimeDeploymentStartup(raw, environment);
  if (selection.mode === 'preinstalled') return; // No publication storage or credentials.
  runtimeDeploymentImage(target, selection.image);
  // A disabled publisher never writes the handoff; do not wait for it.
  if (process.env.RUNTIME_PUBLICATION_ENABLED !== 'true')
    throw new Error('Runtime publication is not enabled for downloaded deployment');
  const accountId = z.string().parse(process.env.RUNTIME_R2_ACCOUNT_ID);
  const bucket = z.string().parse(process.env.RUNTIME_R2_BUCKET);
  if (
    !target.r2_buckets?.some(
      binding => binding.binding === 'RUNTIME_RELEASE_BUCKET' && binding.bucket_name === bucket
    )
  )
    throw new Error('Runtime target bucket binding changed');
  const baseInputId = await runtimeBaseInputId(packageRoot);
  const store = remoteArtifactStore({
    accountId,
    bucket,
    accessKeyId: z.string().parse(process.env.RUNTIME_R2_ACCESS_KEY_ID),
    secretAccessKey: z.string().parse(process.env.RUNTIME_R2_SECRET_ACCESS_KEY),
  });
  const started = Date.now();
  while ((await store.getBytes(runtimeHandoffKey(sourceSha))) === null) {
    if (Date.now() - started > 45 * 60_000)
      throw new Error('Exact-SHA runtime publication did not complete');
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  await withRuntimeRegistry(packageRoot, async () => {
    const config = await prepareRuntimeDeployment({
      config: raw,
      environment,
      sourceSha,
      bucket,
      accountId,
      baseInputId,
      store,
      verifyBase: base => verifyRuntimeBase(base, packageRoot),
    });
    if (!config) throw new Error('Downloaded target changed during preparation');
    const output = path.join(packageRoot, 'wrangler.runtime-generated.json');
    await fs.writeFile(output, JSON.stringify(config));
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
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
