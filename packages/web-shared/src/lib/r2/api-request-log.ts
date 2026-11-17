import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import type { ApiRequestLog2 } from '@kilocode/db/schema';
import {
  EnkryptScanKindSchema,
  EnkryptScanPartSchema,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';

const enkryptRequestLogSchema = z.object({
  guardrail: z.enum(['input', 'output']),
  scan: EnkryptScanKindSchema,
  part: EnkryptScanPartSchema,
  /** Which of the input part's chunks the call scanned; each chunk is scanned by its own calls. */
  chunk: z.object({ index: z.number(), count: z.number() }).optional(),
  request: z.object({
    text: z.string(),
    detectors: z.record(z.string(), z.unknown()),
    user_metadata: z.object({ organization_id: z.string() }),
  }),
  response: z.string().nullable(),
  response_truncated: z.boolean().optional(),
  status_code: z.number().nullable(),
  error: z.string().nullable(),
});

export type EnkryptRequestLog = z.infer<typeof enkryptRequestLogSchema>;

export const apiRequestLogBlobSchema = z.object({
  version: z.literal(2),
  request: z.record(z.string(), z.unknown()),
  response: z.string().nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  enkrypt: z.array(enkryptRequestLogSchema).optional(),
});

export type ApiRequestLogBlob = z.infer<typeof apiRequestLogBlobSchema>;

/** `YYYY/MM/DD/<id>.json`, using the UTC date of `created_at`. */
export function apiRequestLogBlobKey({
  id,
  created_at,
}: Pick<ApiRequestLog2, 'id' | 'created_at'>): string {
  const date = new Date(created_at).toISOString().slice(0, 10).replaceAll('-', '/');
  return `${date}/${id}.json`;
}

type ApiRequestLogStorage = { client: S3Client; bucket: string };

let storage: ApiRequestLogStorage | undefined;

function requireEnvVariable(name: string): string {
  const value = getEnvVariable(name);
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

/**
 * Resolved on first use rather than at import, so missing configuration only
 * affects request logging instead of every module importing the gateway.
 */
function getStorage(): ApiRequestLogStorage {
  storage ??= {
    bucket: requireEnvVariable('R2_API_REQUEST_LOG_BUCKET_NAME'),
    client: createR2Client({
      accessKeyId: requireEnvVariable('R2_API_REQUEST_LOG_ACCESS_KEY_ID'),
      secretAccessKey: requireEnvVariable('R2_API_REQUEST_LOG_SECRET_ACCESS_KEY'),
    }),
  };
  return storage;
}

/** Returns the upload error, or null when the blob was stored. */
export async function uploadApiRequestLogBlob(
  key: string,
  { request, response, error, enkrypt }: Omit<ApiRequestLogBlob, 'version'>
): Promise<string | null> {
  try {
    const { client, bucket } = getStorage();
    const body = {
      version: 2,
      request,
      response,
      error,
      ...(enkrypt?.length ? { enkrypt } : {}),
    } satisfies ApiRequestLogBlob;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json; charset=utf-8',
      })
    );
    return null;
  } catch (uploadError) {
    return String(uploadError);
  }
}

/** Returns null when the object does not exist. */
export async function getApiRequestLogBlob(key: string): Promise<string | null> {
  try {
    const { client, bucket } = getStorage();
    const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await result.Body?.transformToString('utf-8')) ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }
    throw error;
  }
}
