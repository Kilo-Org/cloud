import { z } from 'zod';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import {
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
} from '../src/sandbox-control/runtime-artifact-keys.js';
import {
  parseRuntimeRelease,
  serializeRuntimeRelease,
  type RuntimeReleaseDescriptor,
} from '../src/sandbox-control/runtime-release.js';
import { publishImmutableObject, sha256 } from './runtime-publication.js';
import { runtimeBaseSchema, type RuntimeBase } from './runtime-base.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeHandoffSchema = z
  .object({
    format: z.literal(1),
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    base: runtimeBaseSchema,
    descriptorSha256: hash,
    artifacts: z.tuple([
      z.object({ role: z.literal('cli'), sha256: hash }).strict(),
      z.object({ role: z.literal('control'), sha256: hash }).strict(),
    ]),
    compatibility: z
      .object({
        abi: z.string(),
        bootstrap: z.number().int().positive(),
        protocol: z.string(),
        platform: z
          .object({
            os: z.literal('linux'),
            arch: z.literal('x64'),
            libc: z.literal('glibc'),
            cpu: z.literal('baseline'),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export type RuntimeHandoff = z.infer<typeof runtimeHandoffSchema>;
export const runtimeHandoffKey = (sourceSha: string) => {
  z.string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(sourceSha);
  return 'runtime-artifacts/v1/handoffs/' + sourceSha + '.json';
};

export async function verifyStoredRuntime(
  store: ArtifactObjectStore,
  descriptorSha256: string
): Promise<RuntimeReleaseDescriptor> {
  hash.parse(descriptorSha256);
  const descriptorBytes = await store.getBytes(runtimeArtifactReleaseKey(descriptorSha256));
  if (!descriptorBytes || sha256(descriptorBytes) !== descriptorSha256)
    throw new Error('Runtime descriptor is missing or corrupt');
  const descriptor = parseRuntimeRelease(new TextDecoder().decode(descriptorBytes));
  for (const artifact of descriptor.artifacts) {
    const bytes = await store.getBytes(runtimeArtifactObjectKey(artifact.sha256));
    if (!bytes || bytes.byteLength !== artifact.transferBytes || sha256(bytes) !== artifact.sha256)
      throw new Error('Runtime payload is missing or corrupt');
  }
  return descriptor;
}

export async function publishRuntimeHandoff(input: {
  store: ArtifactObjectStore;
  sourceSha: string;
  base: RuntimeBase;
  descriptor: RuntimeReleaseDescriptor;
}): Promise<RuntimeHandoff> {
  const descriptorSha256 = sha256(serializeRuntimeRelease(input.descriptor));
  const descriptor = await verifyStoredRuntime(input.store, descriptorSha256);
  if (descriptor.abi !== input.base.abi)
    throw new Error('Runtime base ABI does not match the release');
  const cli = descriptor.artifacts.find(artifact => artifact.role === 'cli');
  const control = descriptor.artifacts.find(artifact => artifact.role === 'control');
  if (!cli || !control) throw new Error('Runtime release lacks required payloads');
  const handoff = runtimeHandoffSchema.parse({
    format: 1,
    sourceSha: input.sourceSha,
    base: input.base,
    descriptorSha256,
    artifacts: [
      { role: 'cli', sha256: cli.sha256 },
      { role: 'control', sha256: control.sha256 },
    ],
    compatibility: {
      abi: descriptor.abi,
      bootstrap: descriptor.bootstrap,
      protocol: descriptor.protocol,
      platform: descriptor.platform,
    },
  });
  await publishImmutableObject(
    input.store,
    runtimeHandoffKey(handoff.sourceSha),
    Buffer.from(JSON.stringify(handoff)),
    'application/json'
  );
  return handoff;
}

export async function loadRuntimeHandoff(
  store: ArtifactObjectStore,
  sourceSha: string,
  expectedBaseInputId: string
): Promise<{ handoff: RuntimeHandoff; descriptor: RuntimeReleaseDescriptor }> {
  const bytes = await store.getBytes(runtimeHandoffKey(sourceSha));
  if (!bytes) throw new Error('Exact-SHA runtime handoff is missing');
  const handoff = runtimeHandoffSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  if (handoff.sourceSha !== sourceSha || handoff.base.inputId !== expectedBaseInputId)
    throw new Error('Runtime handoff source or base inputs changed');
  const descriptor = await verifyStoredRuntime(store, handoff.descriptorSha256);
  const expected = {
    abi: descriptor.abi,
    bootstrap: descriptor.bootstrap,
    protocol: descriptor.protocol,
    platform: descriptor.platform,
  };
  if (
    JSON.stringify(handoff.compatibility) !== JSON.stringify(expected) ||
    descriptor.abi !== handoff.base.abi ||
    handoff.artifacts.some(
      reference =>
        !descriptor.artifacts.some(
          artifact => artifact.role === reference.role && artifact.sha256 === reference.sha256
        )
    )
  )
    throw new Error('Runtime handoff compatibility or payload references changed');
  return { handoff, descriptor };
}
