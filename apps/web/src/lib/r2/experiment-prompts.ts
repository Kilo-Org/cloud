import { GetObjectCommand } from '@aws-sdk/client-s3';
import { captureException } from '@sentry/nextjs';
import { r2Client, r2ExperimentPromptsBucketName } from './client';

function isBucketConfigured(): boolean {
  return r2ExperimentPromptsBucketName.length > 0;
}

/**
 * Reads the prompt content for a given sha256 hex digest, or returns null
 * when the object does not exist. Sentinels (`__absent__`, `__failed__`,
 * `__deleted__`) MUST be filtered before calling this.
 */
export async function getPromptByHash(sha: string): Promise<string | null> {
  if (!isBucketConfigured()) {
    return null;
  }
  if (!/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error('getPromptByHash requires a 64-char lowercase hex sha256');
  }
  try {
    const response = await r2Client.send(
      new GetObjectCommand({
        Bucket: r2ExperimentPromptsBucketName,
        Key: sha,
      })
    );
    if (!response.Body) return null;
    return await response.Body.transformToString();
  } catch (err) {
    if (isNotFoundError(err)) return null;
    captureException(err, {
      tags: { source: 'experiment-prompts', operation: 'getPromptByHash' },
      extra: { sha },
    });
    throw err;
  }
}

function isNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404;
}
