import { z } from 'zod';
import {
  runtimeStartupConfigSchema,
  type RuntimeStartupConfig,
} from '../src/shared/runtime-startup-config.js';

const targetName = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const runtimeTargetsSchema = z
  .object({
    default: runtimeStartupConfigSchema,
    targets: z.record(targetName, runtimeStartupConfigSchema),
  })
  .strict();
export function selectRuntimeTarget(raw: unknown, environment: string): RuntimeStartupConfig {
  targetName.parse(environment);
  const targets = runtimeTargetsSchema.parse(raw);
  return Object.hasOwn(targets.targets, environment)
    ? targets.targets[environment]
    : targets.default;
}

const configSchema = z
  .object({
    vars: z.record(z.string(), z.unknown()).optional(),
    r2_buckets: z
      .array(z.object({ binding: z.string(), bucket_name: z.string() }).passthrough())
      .optional(),
    containers: z
      .array(
        z
          .object({
            class_name: z.string(),
            images: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
      )
      .optional(),
    env: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export function runtimeDeploymentConfig(raw: unknown, environment: string) {
  const root = configSchema.parse(raw);
  const target = environment === 'production' ? root : configSchema.parse(root.env?.[environment]);
  return { root, target };
}

export function validateRuntimeTarget(config: unknown, environment: string) {
  const { root, target } = runtimeDeploymentConfig(config, environment);
  const vars = target.vars ?? {};
  if (
    ['RUNTIME_STARTUP_MODE', 'NATIVE_RUNTIME_IMAGE', 'RUNTIME_RELEASE_DESCRIPTOR'].some(
      key => vars[key] !== undefined
    )
  )
    throw new Error('Runtime configuration drift: startup settings belong in runtime-targets.json');
  const native = target.containers?.find(container => container.class_name === 'SandboxContainers');
  if (!native?.images?.app) throw new Error('Runtime target lacks its native app image');
  const image = z
    .object({
      dockerfile: z.literal('./Dockerfile.containers'),
      build_vars: z.record(z.string(), z.string()).optional(),
    })
    .strict()
    .safeParse(native.images.app);
  if (!image.success)
    throw new Error(
      'Runtime configuration drift: native image must be rendered from runtime-targets.json'
    );

  return { root, target, vars, native };
}

export function runtimeBucketBindings(
  current: ReturnType<typeof runtimeDeploymentConfig>['target']['r2_buckets'],
  bucketName: string
) {
  const bucket = z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/)
    .parse(bucketName);
  const bindings = current ?? [];
  const existing = bindings.find(binding => binding.binding === 'RUNTIME_RELEASE_BUCKET');
  if (existing && existing.bucket_name !== bucket)
    throw new Error('Runtime target bucket binding changed');
  return existing
    ? bindings
    : [...bindings, { binding: 'RUNTIME_RELEASE_BUCKET', bucket_name: bucket }];
}

export type RuntimeTargetRelease = { descriptorSha256: string; baseImage: string; bucket: string };
/** The target catalog owns both Worker vars and the native image selection. */
export function renderRuntimeTarget(input: {
  config: unknown;
  environment: string;
  startup: RuntimeStartupConfig;
  release?: RuntimeTargetRelease;
}) {
  const startup = runtimeStartupConfigSchema.parse(input.startup);
  const { root, target, vars, native } = validateRuntimeTarget(input.config, input.environment);
  target.vars = {
    ...vars,
    RUNTIME_STARTUP_MODE: startup.mode,
    NATIVE_RUNTIME_IMAGE: startup.image,
  };
  if (startup.mode === 'downloaded') {
    const release = input.release;
    if (!release) throw new Error('Downloaded target requires a verified runtime handoff');
    target.r2_buckets = runtimeBucketBindings(target.r2_buckets, release.bucket);
    target.vars.RUNTIME_RELEASE_DESCRIPTOR = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(release.descriptorSha256);
    if (startup.image === 'runtime-free') {
      const digest = z
        .string()
        .regex(/^registry\.cloudflare\.com\/[a-f0-9]{32}\/kilo-runtime-base@sha256:[a-f0-9]{64}$/)
        .parse(release.baseImage);
      native.images = { ...native.images, app: { image: digest } };
    }
  }
  if (input.environment !== 'production') root.env = { ...root.env, [input.environment]: target };
  return root;
}
