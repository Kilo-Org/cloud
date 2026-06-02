import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { captureException } from '@sentry/nextjs';
import { r2Client, r2ExperimentPromptsBucketName } from './client';

/**
 * Content-addressed prompt storage for model experiments.
 *
 * Each unique blob is written once under its sha256 hex digest as the
 * object key. `model_experiment_request` rows reference only the hash, so
 * deduplication is automatic across requests sharing identical content
 * (e.g. a system prompt repeated across thousands of agentic turns).
 *
 * - Bucket: `R2_EXPERIMENT_PROMPTS_BUCKET_NAME` (one per environment).
 * - Trust boundary: same R2 credentials as cli-sessions and
 *   cloud-agent-attachments. Prompts collected under explicit experiment
 *   opt-in use a dedicated retention policy and are NOT subject to the
 *   default `microdollar_usage_metadata` soft-delete; `softDeleteUser`
 *   does not touch these rows or their R2 objects.
 *
 * Failures here MUST NOT roll back the microdollar usage write or the
 * experiment attribution row. Callers store `__failed__` for the affected
 * side and continue.
 */

/** Lowercase hex sha256. Used both as content hash and as the R2 object key. */
export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function isBucketConfigured(): boolean {
  return r2ExperimentPromptsBucketName.length > 0;
}

/**
 * Write `content` under its sha256 hex digest if the object does not
 * already exist. Returns the digest used as the object key.
 *
 * Concurrent races between two requests writing the same content are
 * harmless — the worst case is two simultaneous PUTs with identical bytes
 * and the same final state in R2.
 *
 * Throws on R2 errors; callers must catch and store `__failed__` so the
 * experiment attribution row still lands.
 */
export async function putPromptIfAbsent(content: string): Promise<string> {
  if (!isBucketConfigured()) {
    throw new Error('R2_EXPERIMENT_PROMPTS_BUCKET_NAME is not configured');
  }
  const sha = sha256Hex(content);
  // HEAD-then-PUT is the same shape used by cli-sessions copyBlobs and is
  // sufficient for content-addressed dedup. Strong consistency on R2 is not
  // guaranteed across regions, but the put-on-miss collisions are
  // idempotent (same content, same key) so any race is harmless.
  try {
    await r2Client.send(
      new HeadObjectCommand({
        Bucket: r2ExperimentPromptsBucketName,
        Key: sha,
      })
    );
    return sha;
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err;
    }
  }
  await r2Client.send(
    new PutObjectCommand({
      Bucket: r2ExperimentPromptsBucketName,
      Key: sha,
      Body: content,
      ContentType: 'application/json; charset=utf-8',
    })
  );
  return sha;
}

export async function putPromptOrNull(content: string): Promise<string | null> {
  try {
    return await putPromptIfAbsent(content);
  } catch (err) {
    captureException(err, {
      tags: { source: 'experiment-prompts', operation: 'putPromptIfAbsent' },
    });
    return null;
  }
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
