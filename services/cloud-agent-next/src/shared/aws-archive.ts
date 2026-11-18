import { z } from 'zod';
import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import { rootfsArchiveDescriptorSchema } from './rootfs-archive.js';

/**
 * The isolated wrapper build cannot resolve `@kilocode/worker-utils` values, so
 * `aws-archive.parity.test.ts` holds these equal to the BYOC configuration fields.
 */
export const awsArchiveIdentityFields = {
  region: z.literal('us-east-1'),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
  stackId: z
    .string()
    .regex(/^arn:aws:cloudformation:us-east-1:\d{12}:stack\/[A-Za-z0-9-]+\/[a-f0-9-]+$/),
  imageIdentifier: z
    .string()
    .regex(/^arn:aws:lambda:us-east-1:\d{12}:microvm-image:[A-Za-z0-9_-]+$/),
  imageVersion: z.string().regex(/^\d+\.\d+$/),
};

const baseSchema = z
  .object({
    connectionId: z.uuid(),
    ...awsArchiveIdentityFields,
  })
  .strict()
  .refine(value => value.stackId.split(':')[4] === value.imageIdentifier.split(':')[4]);
export type AwsArchiveBase = z.infer<typeof baseSchema>;
const BASE_PREFIX = 'aws-image:v1:';
const SNAPSHOT_PREFIX = 'aws-archive:v1:';
const MAX_ENCODED_CHARS = 8192;

function encode(prefix: string, value: unknown): string {
  const result =
    prefix +
    btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (result.length > MAX_ENCODED_CHARS) throw new Error('AWS archive identity exceeds the limit');
  return result;
}
function decode(prefix: string, value: string): unknown {
  if (!value.startsWith(prefix) || value.length > MAX_ENCODED_CHARS) return null;
  const encoded = value.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const data = encoded.replaceAll('-', '+').replaceAll('_', '/');
    return JSON.parse(atob(data + '='.repeat((4 - (data.length % 4)) % 4))) as unknown;
  } catch {
    return null;
  }
}

/** Public compatibility identity. External IDs, role credentials and proxy secrets never enter snapshot IDs. */
export function awsArchiveBaseImage(
  connectionId: string,
  configuration: AwsByocConfiguration
): string {
  const { region, bucket, stackId, imageIdentifier, imageVersion } = configuration;
  return encode(
    BASE_PREFIX,
    baseSchema.parse({ connectionId, region, bucket, stackId, imageIdentifier, imageVersion })
  );
}
export function decodeAwsArchiveBase(value: string): AwsArchiveBase | null {
  return baseSchema.safeParse(decode(BASE_PREFIX, value)).data ?? null;
}
export const awsArchiveSnapshotSchema = z
  .object({
    format: z.literal(1),
    captureId: z.uuid(),
    environmentId: z.uuid(),
    buildId: z.uuid(),
    allocationId: z.uuid(),
    archive: rootfsArchiveDescriptorSchema,
  })
  .strict()
  .refine(value => decodeAwsArchiveBase(value.archive.baseImage) !== null);
export type AwsArchiveSnapshot = z.infer<typeof awsArchiveSnapshotSchema>;
export function encodeAwsArchiveSnapshot(snapshot: AwsArchiveSnapshot): string {
  return encode(SNAPSHOT_PREFIX, awsArchiveSnapshotSchema.parse(snapshot));
}
export function decodeAwsArchiveSnapshot(value: string): AwsArchiveSnapshot | null {
  return awsArchiveSnapshotSchema.safeParse(decode(SNAPSHOT_PREFIX, value)).data ?? null;
}
export function awsArchiveObjectKey(
  input: Pick<AwsArchiveSnapshot, 'environmentId' | 'buildId' | 'allocationId'>
): string {
  const identity = z
    .object({ environmentId: z.uuid(), buildId: z.uuid(), allocationId: z.uuid() })
    .parse(input);
  return `kilo/archives/environments/${identity.environmentId}/${identity.buildId}/${identity.allocationId}.tar`;
}

/** Filesystem deltas require the exact base and the same account, connection and bucket. */
export function awsArchiveMatchesBase(
  snapshot: AwsArchiveSnapshot,
  currentBaseImage: string
): boolean {
  const current = decodeAwsArchiveBase(currentBaseImage);
  const stored = decodeAwsArchiveBase(snapshot.archive.baseImage);
  return current !== null && stored !== null && JSON.stringify(stored) === JSON.stringify(current);
}
