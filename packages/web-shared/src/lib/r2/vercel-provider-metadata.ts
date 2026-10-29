import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { after } from 'next/server';

export type VercelProviderMetadataCapture = (metadata: unknown, generationId?: string) => void;

let client: S3Client | undefined;

export function createVercelProviderMetadataCapture(): VercelProviderMetadataCapture | undefined {
  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const bucket = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_BUCKET_NAME');
  const accessKeyId = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_ACCESS_KEY_ID');
  const secretAccessKey = getEnvVariable('R2_VERCEL_PROVIDER_METADATA_SECRET_ACCESS_KEY');
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    console.debug('[vercel-provider-metadata] capture disabled: missing configuration', {
      accountConfigured: Boolean(accountId),
      bucketConfigured: Boolean(bucket),
      accessKeyIdConfigured: Boolean(accessKeyId),
      secretAccessKeyConfigured: Boolean(secretAccessKey),
    });
    return undefined;
  }

  let capturedMetadata: object | undefined;
  let capturedGenerationId: string | undefined;
  let waitingLogged = false;
  let registrationAttempted = false;

  return (metadata, generationId) => {
    if (typeof generationId === 'string' && generationId.length > 0) {
      capturedGenerationId = generationId;
    }
    if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      capturedMetadata = metadata;
    }
    if (registrationAttempted) return;
    if (!capturedMetadata || !capturedGenerationId) {
      if (!waitingLogged && (metadata !== undefined || capturedGenerationId)) {
        console.debug('[vercel-provider-metadata] waiting for metadata and generation ID', {
          generationId: capturedGenerationId,
          metadataReceived: Boolean(capturedMetadata),
          generationIdReceived: Boolean(capturedGenerationId),
        });
        waitingLogged = true;
      }
      return;
    }

    const reportFailure = (stage: 'registration' | 'upload', error: unknown) =>
      errorExceptInTest('[vercel-provider-metadata] failed to archive metadata', {
        generationId: capturedGenerationId,
        bucket,
        stage,
        errorType: error instanceof Error ? error.name : 'unknown',
        ...(error instanceof S3ServiceException
          ? {
              httpStatusCode: error.$metadata.httpStatusCode,
              requestId: error.$metadata.requestId,
              attempts: error.$metadata.attempts,
            }
          : {}),
      });

    registrationAttempted = true;
    try {
      console.debug('[vercel-provider-metadata] scheduling archive', {
        generationId: capturedGenerationId,
        bucket,
      });
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
          console.debug('[vercel-provider-metadata] archived metadata', {
            generationId: capturedGenerationId,
            bucket,
          });
        } catch (error) {
          reportFailure('upload', error);
        }
      });
    } catch (error) {
      reportFailure('registration', error);
    }
  };
}
