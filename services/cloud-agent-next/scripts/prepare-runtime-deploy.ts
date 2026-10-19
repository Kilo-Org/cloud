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
      baseImage: handoff.base.image,
      bucket: input.bucket,
    },
  });
  await input.verifyBase(handoff.base);
  return config;
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
  // A disabled publisher never writes the handoff; do not wait for it.
  if (process.env.RUNTIME_PUBLICATION_ENABLED !== 'true')
    throw new Error('Runtime publication is not enabled for downloaded deployment');
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
