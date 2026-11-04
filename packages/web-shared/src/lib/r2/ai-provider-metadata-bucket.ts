import { PutObjectCommand, S3ServiceException, type S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { after } from 'next/server';

export type AiProviderMetadataBucket = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type ArchiveLogContext = Record<string, string>;

let client: S3Client | undefined;

/** The shared AI provider metadata bucket, or undefined when any of its settings is missing. */
export function getAiProviderMetadataBucket(
  logSource: string
): AiProviderMetadataBucket | undefined {
  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  const bucket = getEnvVariable('R2_AI_PROVIDER_METADATA_BUCKET_NAME');
  const accessKeyId = getEnvVariable('R2_AI_PROVIDER_METADATA_ACCESS_KEY_ID');
  const secretAccessKey = getEnvVariable('R2_AI_PROVIDER_METADATA_SECRET_ACCESS_KEY');
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
    console.debug(`[${logSource}] capture disabled: missing configuration`, {
      accountConfigured: Boolean(accountId),
      bucketConfigured: Boolean(bucket),
      accessKeyIdConfigured: Boolean(accessKeyId),
      secretAccessKeyConfigured: Boolean(secretAccessKey),
    });
    return undefined;
  }
  return { bucket, accessKeyId, secretAccessKey };
}

/**
 * Uploads one JSON object after the response. `body` runs at upload time, so it can include what
 * the response observed after scheduling. Failures are reported without the object, the raw error,
 * or credentials, and never reach the caller.
 */
export function scheduleAiProviderMetadataArchive({
  target: { bucket, accessKeyId, secretAccessKey },
  logSource,
  logContext,
  key,
  body,
}: {
  target: AiProviderMetadataBucket;
  logSource: string;
  logContext: ArchiveLogContext;
  key: string;
  body: () => string | Promise<string>;
}): void {
  const reportFailure = (stage: 'registration' | 'upload', error: unknown) =>
    errorExceptInTest(`[${logSource}] failed to archive metadata`, {
      ...logContext,
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

  try {
    console.debug(`[${logSource}] scheduling archive`, { ...logContext, bucket });
    after(async () => {
      try {
        const serializedBody = await body();
        client ??= createR2Client({ accessKeyId, secretAccessKey });
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: serializedBody,
            ContentType: 'application/json',
          })
        );
        console.debug(`[${logSource}] archived metadata`, { ...logContext, bucket });
      } catch (error) {
        reportFailure('upload', error);
      }
    });
  } catch (error) {
    reportFailure('registration', error);
  }
}
