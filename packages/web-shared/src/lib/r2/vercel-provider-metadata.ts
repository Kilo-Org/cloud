import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';

type VercelProviderMetadataStorage = { client: S3Client; bucket: string };

let storage: VercelProviderMetadataStorage | null | undefined;

const GENERATION_ID_PATTERN = /^gen_[A-Za-z0-9]{1,128}$/;

/** Vercel AI Gateway generation ids look like `gen_01KKGSWN56EG1YK9Q5ZV5V4GQ9`. */
export function isVercelGenerationId(value: string): boolean {
  return GENERATION_ID_PATTERN.test(value);
}

function objectKey(generationId: string) {
  return `${generationId}.json`;
}

/**
 * Resolved on first use rather than at import. Null when the bucket is not
 * configured, as in local development, so storing becomes a no-op there.
 */
function getStorage(): VercelProviderMetadataStorage | null {
  if (storage === undefined) {
    const bucket = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME');
    const accessKeyId = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID');
    const secretAccessKey = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY');
    storage =
      bucket && accessKeyId && secretAccessKey
        ? { bucket, client: createR2Client({ accessKeyId, secretAccessKey }) }
        : null;
  }
  return storage;
}

/**
 * Best effort: never throws. Storage is not guaranteed for every generation,
 * so readers must tolerate a missing object.
 */
export async function storeVercelProviderMetadata(
  generationId: string,
  providerMetadata: unknown
): Promise<void> {
  try {
    if (!isVercelGenerationId(generationId)) {
      console.warn('[vercel-provider-metadata] not storing metadata for invalid generation id', {
        generationId: generationId.slice(0, 200),
      });
      return;
    }
    const resolvedStorage = getStorage();
    if (!resolvedStorage) return;
    await resolvedStorage.client.send(
      new PutObjectCommand({
        Bucket: resolvedStorage.bucket,
        Key: objectKey(generationId),
        Body: JSON.stringify(providerMetadata),
        ContentType: 'application/json; charset=utf-8',
      })
    );
  } catch (error) {
    console.warn('[vercel-provider-metadata] failed to store metadata', {
      generationId,
      error: String(error),
    });
  }
}

export class VercelProviderMetadataStorageNotConfiguredError extends Error {
  constructor() {
    super('Vercel provider metadata storage is not configured');
    this.name = 'VercelProviderMetadataStorageNotConfiguredError';
  }
}

/**
 * Returns the stored JSON text, or null when nothing is stored for the
 * generation: it was never stored or has since been cleaned up.
 */
export async function getVercelProviderMetadata(generationId: string): Promise<string | null> {
  if (!isVercelGenerationId(generationId)) return null;
  const resolvedStorage = getStorage();
  if (!resolvedStorage) {
    throw new VercelProviderMetadataStorageNotConfiguredError();
  }
  try {
    const result = await resolvedStorage.client.send(
      new GetObjectCommand({ Bucket: resolvedStorage.bucket, Key: objectKey(generationId) })
    );
    return (await result.Body?.transformToString('utf-8')) ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }
    throw error;
  }
}
