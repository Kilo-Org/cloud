import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { after } from 'next/server';

export type VercelProviderMetadataCapture = (metadata: unknown, generationId?: string) => void;

let client: S3Client | undefined;

export function createVercelProviderMetadataCapture(): VercelProviderMetadataCapture | undefined {
  const bucket = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME');
  const accessKeyId = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID');
  const secretAccessKey = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY');
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;

  let capturedMetadata: object | undefined;
  let capturedGenerationId: string | undefined;
  let registrationAttempted = false;

  return (metadata, generationId) => {
    if (typeof generationId === 'string' && generationId.length > 0) {
      capturedGenerationId = generationId;
    }
    if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      capturedMetadata = metadata;
    }
    if (registrationAttempted || !capturedMetadata || !capturedGenerationId) return;

    const reportFailure = (error: unknown) =>
      errorExceptInTest('[vercel-provider-metadata] failed to archive metadata', {
        generationId: capturedGenerationId,
        errorType: error instanceof Error ? error.name : 'unknown',
      });

    registrationAttempted = true;
    try {
      after(async () => {
        try {
          client ??= createR2Client({ accessKeyId, secretAccessKey });
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `${capturedGenerationId}.json`,
              Body: JSON.stringify(capturedMetadata),
              ContentType: 'application/json',
            })
          );
        } catch (error) {
          reportFailure(error);
        }
      });
    } catch (error) {
      reportFailure(error);
    }
  };
}
