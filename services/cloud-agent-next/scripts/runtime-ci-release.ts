import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import {
  publishImmutableObject,
  runtimeArtifactReleaseKey,
  type ArtifactObjectStore,
} from '../src/sandbox-control/runtime-artifact-store.js';
import {
  parseRuntimeRelease,
  RUNTIME_BASE_ABI,
  serializeRuntimeRelease,
} from '../src/shared/runtime-release.js';
import { publishRuntimeRelease, sha256, type PackagedRuntime } from './publish-runtime.js';
import { verifyRelease } from './runtime-release-preflight.js';
import type { RuntimeInputs } from './runtime-ci-inputs.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const baseEvidenceSchema = z
  .object({
    format: z.literal('kilo-native-base-v1'),
    inputSha256: hashSchema,
    image: z
      .string()
      .regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/),
    sourceSha: sourceShaSchema,
    platform: z.literal('linux/amd64'),
    abi: z.literal(RUNTIME_BASE_ABI),
  })
  .strict();
export type BaseEvidence = z.infer<typeof baseEvidenceSchema>;

/** The protected CI index key for a native base's evidence record. */
export function nativeBaseRecordKey(inputSha256: string): string {
  return `runtime-artifacts/v1/bases/${inputSha256}.json`;
}

/**
 * READ-ONLY resolution of trusted base evidence from the protected CI index.
 * Returns null when no record exists for the input fingerprint; callers must
 * refuse qualification rather than fabricate a digest claim.
 */
export async function readNativeBaseEvidence(
  store: ArtifactObjectStore,
  inputSha256: string
): Promise<BaseEvidence | null> {
  const bytes = await store.getBytes(nativeBaseRecordKey(inputSha256));
  if (bytes === null) return null;
  const base = baseEvidenceSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (base.inputSha256 !== inputSha256)
    throw new Error('trusted base evidence conflicts with its key');
  return base;
}
const runtimeEvidenceSchema = z
  .object({
    format: z.literal('kilo-runtime-inputs-v1'),
    inputSha256: hashSchema,
    descriptorSha256: hashSchema,
  })
  .strict();
export const releaseBundleSchema = z
  .object({
    format: z.literal('kilo-runtime-ci-v1'),
    mode: z.literal('candidate'),
    sourceSha: sourceShaSchema,
    environment: z.enum(['production', 'staging']),
    accountId: z.string().regex(/^[a-f0-9]{32}$/),
    bucket: z.string(),
    configSha256: hashSchema,
    runtimeInputSha256: hashSchema,
    descriptorSha256: hashSchema,
    base: baseEvidenceSchema,
  })
  .strict();
export type ReleaseBundle = z.infer<typeof releaseBundleSchema>;

const imageSchema = z
  .object({ dockerfile: z.string().optional(), image: z.string().optional() })
  .passthrough();
const environmentSchema = z
  .object({
    name: z.string(),
    vars: z.record(z.string(), z.unknown()).optional(),
    r2_buckets: z.array(z.object({ binding: z.string(), bucket_name: z.string() }).passthrough()),
    containers: z.array(
      z
        .object({
          class_name: z.string(),
          image: z.string().optional(),
          images: z.record(z.string(), imageSchema).optional(),
        })
        .passthrough()
    ),
  })
  .passthrough();
const configSchema = environmentSchema
  .extend({
    account_id: z.string().regex(/^[a-f0-9]{32}$/),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export function selectReleaseTarget(source: string, environment: string) {
  if (environment !== 'production' && environment !== 'staging')
    throw new Error('unsupported runtime release environment');
  const errors: ParseError[] = [];
  const config = configSchema.parse(parseJsonc(source, errors, { allowTrailingComma: true }));
  if (errors.length) throw new Error('Worker configuration is not valid JSONC');
  if (environment !== 'production' && config.env?.[environment] === undefined)
    throw new Error(
      `Cloud Agent has no committed env.${environment}; refusing production fallback`
    );
  const selected =
    environment === 'production' ? config : environmentSchema.parse(config.env?.[environment]);
  const bucket = selected.r2_buckets.find(
    binding => binding.binding === 'RUNTIME_RELEASE_BUCKET'
  )?.bucket_name;
  if (!bucket)
    throw new Error('runtime release requires the selected environment RUNTIME_RELEASE_BUCKET');
  if (
    selected.r2_buckets.some(
      binding => binding.binding !== 'RUNTIME_RELEASE_BUCKET' && binding.bucket_name === bucket
    )
  ) {
    throw new Error('runtime releases require a dedicated bucket, not shared session storage');
  }
  if (Object.hasOwn(selected.vars ?? {}, 'RUNTIME_RELEASE_DESCRIPTOR'))
    throw new Error('native runtime activation remains gated; descriptor must be absent');
  const native = selected.containers.find(
    container => container.class_name === 'SandboxContainers'
  );
  if (
    native?.images?.app?.dockerfile !== './Dockerfile.containers' ||
    native.images.app.image !== undefined ||
    selected.containers.some(container => container.image?.includes('runtime-free'))
  ) {
    throw new Error('native runtime activation remains gated; keep the baked production images');
  }
  return { config, environment, accountId: config.account_id, bucket, workerName: selected.name };
}

export async function verifyPublishedRuntime(
  store: ArtifactObjectStore,
  descriptorBytes: Uint8Array,
  expectedHash: string,
  inputs: RuntimeInputs
) {
  const descriptor = parseRuntimeRelease(descriptorBytes);
  if (
    descriptor.cliVersion !== inputs.cliVersion ||
    descriptor.wrapperSdkVersion !== inputs.wrapperSdkVersion ||
    descriptor.abi !== RUNTIME_BASE_ABI
  ) {
    throw new Error('published runtime does not match the selected runtime pins');
  }
  const checks = await verifyRelease(descriptorBytes, {
    descriptorSha256: expectedHash,
    read: key => store.getBytes(key),
  });
  if (checks.some(check => !check.passed))
    throw new Error(
      `runtime release verification failed: ${checks
        .filter(check => !check.passed)
        .map(check => check.name)
        .join(', ')}`
    );
}

export async function prepareCandidateRelease(options: {
  store: ArtifactObjectStore;
  inputs: RuntimeInputs;
  packageRuntime: () => Promise<PackagedRuntime>;
  buildBase: () => Promise<BaseEvidence>;
  verifyBase: (base: BaseEvidence) => Promise<void>;
}) {
  const { store, inputs } = options;
  const runtimeKey = `runtime-artifacts/v1/inputs/${inputs.runtimeSha256}.json`;
  const existingRuntime = await store.getBytes(runtimeKey);
  let descriptorBytes: Uint8Array;
  let descriptorSha256: string;
  if (existingRuntime !== null) {
    const evidence = runtimeEvidenceSchema.parse(
      JSON.parse(new TextDecoder().decode(existingRuntime))
    );
    if (evidence.inputSha256 !== inputs.runtimeSha256)
      throw new Error('runtime input evidence conflicts with its key');
    descriptorSha256 = evidence.descriptorSha256;
    const bytes = await store.getBytes(runtimeArtifactReleaseKey(descriptorSha256));
    if (bytes === null)
      throw new Error('runtime input evidence refers to missing release evidence');
    descriptorBytes = bytes;
    await verifyPublishedRuntime(store, descriptorBytes, descriptorSha256, inputs);
  } else {
    const packaged = await options.packageRuntime();
    descriptorBytes = serializeRuntimeRelease(packaged.descriptor);
    descriptorSha256 = sha256(descriptorBytes);
    await publishRuntimeRelease(store, packaged);
    await verifyPublishedRuntime(store, descriptorBytes, descriptorSha256, inputs);
    const bytes = new TextEncoder().encode(
      JSON.stringify(
        runtimeEvidenceSchema.parse({
          format: 'kilo-runtime-inputs-v1',
          inputSha256: inputs.runtimeSha256,
          descriptorSha256,
        })
      )
    );
    await publishImmutableObject(store, {
      key: runtimeKey,
      bytes,
      expectedSha256: sha256(bytes),
      contentType: 'application/json',
    });
  }
  const baseKey = nativeBaseRecordKey(inputs.baseSha256);
  const existingBase = await store.getBytes(baseKey);
  let base: BaseEvidence;
  if (existingBase !== null) {
    base = baseEvidenceSchema.parse(JSON.parse(new TextDecoder().decode(existingBase)));
  } else {
    const built = baseEvidenceSchema.parse(await options.buildBase());
    if (built.inputSha256 !== inputs.baseSha256)
      throw new Error('built base does not match its inputs');
    await options.verifyBase(built);
    const bytes = new TextEncoder().encode(JSON.stringify(built));
    await store.putIfAbsent(baseKey, bytes, 'application/json');
    const stored = await store.getBytes(baseKey);
    if (stored === null) throw new Error('base evidence is missing after publication');
    base = baseEvidenceSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
    if (base.image !== built.image)
      throw new Error('base evidence conflicts with the published digest');
  }
  if (base.inputSha256 !== inputs.baseSha256)
    throw new Error('base input evidence conflicts with its key');
  await options.verifyBase(base);
  return {
    descriptorBytes,
    descriptorSha256,
    base,
    runtimeReused: existingRuntime !== null,
    baseReused: existingBase !== null,
  };
}

export function verifyReleaseBundle(
  bundle: ReleaseBundle,
  options: {
    sourceSha: string;
    environment: string;
    configSource: string;
    inputs: RuntimeInputs;
    descriptorBytes: Uint8Array;
  }
) {
  const target = selectReleaseTarget(options.configSource, options.environment);
  if (
    bundle.sourceSha !== options.sourceSha ||
    bundle.environment !== options.environment ||
    bundle.accountId !== target.accountId ||
    bundle.bucket !== target.bucket ||
    bundle.configSha256 !== sha256(new TextEncoder().encode(options.configSource)) ||
    bundle.runtimeInputSha256 !== options.inputs.runtimeSha256 ||
    bundle.base.inputSha256 !== options.inputs.baseSha256 ||
    bundle.descriptorSha256 !== sha256(options.descriptorBytes)
  ) {
    throw new Error(
      'CI release artifact does not match the deployment checkout, environment, or inputs'
    );
  }
  if (!bundle.base.image.startsWith(`registry.cloudflare.com/${target.accountId}/`))
    throw new Error('base candidate belongs to a different account');
  return target.config;
}
