import { DeleteObjectsCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { r2ApiRequestLogBucketName, r2Client } from './client';

const apiRequestLogPayloadSchema = z.object({
  version: z.literal(1),
  request: z.unknown(),
  response: z.string().nullable(),
});
const apiRequestLogObjectKeyPattern =
  /^api-request-logs\/v1\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json\.gz$/;
const R2_REQUEST_TIMEOUT_MS = 10_000;

export type ApiRequestLogPayload = z.infer<typeof apiRequestLogPayloadSchema>;
export type ApiRequestLogPayloadDeleteResult = {
  deletedKeys: string[];
  failedKeys: string[];
};

function getBucketName(): string | null {
  if (!r2ApiRequestLogBucketName) {
    return null;
  }
  return r2ApiRequestLogBucketName;
}

function requireObjectKey(key: string): string {
  if (!apiRequestLogObjectKeyPattern.test(key)) {
    throw new Error('Invalid API request log object key');
  }
  return key;
}

function createObjectKey(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll('-', '/');
  return `api-request-logs/v1/${date}/${randomUUID()}.json.gz`;
}

export async function putApiRequestLogPayload(
  payload: Omit<ApiRequestLogPayload, 'version'>
): Promise<string | null> {
  const bucket = getBucketName();
  if (!bucket) return null;

  const key = createObjectKey(new Date());
  const body = gzipSync(JSON.stringify({ version: 1, ...payload } satisfies ApiRequestLogPayload));

  await r2Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json; charset=utf-8',
      ContentEncoding: 'gzip',
    }),
    { abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) }
  );

  return key;
}

export async function getApiRequestLogPayload(key: string): Promise<ApiRequestLogPayload> {
  const bucket = getBucketName();
  if (!bucket) throw new Error('R2_EXPERIMENT_PROMPTS_BUCKET_NAME is not configured');

  const object = await r2Client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: requireObjectKey(key),
    }),
    { abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) }
  );
  if (!object.Body) {
    throw new Error(`R2 object ${key} has no body`);
  }

  const compressed = await object.Body.transformToByteArray();
  const parsed: unknown = JSON.parse(gunzipSync(compressed).toString('utf8'));
  return apiRequestLogPayloadSchema.parse(parsed);
}

export async function deleteApiRequestLogPayloads(
  keys: string[]
): Promise<ApiRequestLogPayloadDeleteResult> {
  const bucket = getBucketName();
  if (!bucket) throw new Error('R2_EXPERIMENT_PROMPTS_BUCKET_NAME is not configured');
  const validatedKeys = keys.map(requireObjectKey);
  const deletedKeys: string[] = [];
  const failedKeys: string[] = [];

  for (let offset = 0; offset < validatedKeys.length; offset += 1_000) {
    const chunk = validatedKeys.slice(offset, offset + 1_000);
    try {
      const result = await r2Client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: chunk.map(Key => ({ Key })),
            Quiet: true,
          },
        }),
        { abortSignal: AbortSignal.timeout(R2_REQUEST_TIMEOUT_MS) }
      );
      const errors = result.Errors ?? [];
      const failedInChunk = new Set(
        errors.some(error => !error.Key)
          ? chunk
          : errors.flatMap(error => (error.Key ? [error.Key] : []))
      );
      deletedKeys.push(...chunk.filter(key => !failedInChunk.has(key)));
      failedKeys.push(...chunk.filter(key => failedInChunk.has(key)));
    } catch {
      failedKeys.push(...chunk);
    }
  }

  return { deletedKeys, failedKeys };
}
