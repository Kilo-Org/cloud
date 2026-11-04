import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ApiRequestLog } from '@kilocode/db/schema';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';

export type ApiRequestLogBlobUpload = {
  columns: Pick<ApiRequestLog, 'request_r2_key' | 'response_r2_key'>;
  uploadError: string | null;
};

export const enkryptRequestLogSchema = z.object({
  guardrail: z.enum(['input', 'output']),
  scan: z.enum(['blocking', 'log_only']),
  request: z.object({
    text: z.string(),
    detectors: z.record(z.string(), z.unknown()),
    user_metadata: z.object({ organization_id: z.string() }),
  }),
  response: z.string().nullable(),
  status_code: z.number().nullable(),
  error: z.string().nullable(),
});

export type EnkryptRequestLog = z.infer<typeof enkryptRequestLogSchema>;

export const apiRequestLogBlobSchema = z.object({
  version: z.literal(1),
  request: z.record(z.string(), z.unknown()),
  response: z.string().nullable(),
  enkrypt: z.array(enkryptRequestLogSchema).optional(),
});

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

export async function uploadApiRequestLogBlobs({
  request,
  response,
  enkrypt,
}: {
  request: Record<string, unknown>;
  response: string | undefined;
  enkrypt?: EnkryptRequestLog[];
}): Promise<ApiRequestLogBlobUpload> {
  try {
    const { client, bucket } = getStorage();
    const key = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}/record.v1.json`;
    const body = {
      version: 1,
      request,
      response: response ?? null,
      ...(enkrypt?.length ? { enkrypt } : {}),
    } satisfies z.infer<typeof apiRequestLogBlobSchema>;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(body),
        ContentType: 'application/json; charset=utf-8',
      })
    );
    return {
      columns: { request_r2_key: key, response_r2_key: key },
      uploadError: null,
    };
  } catch (error) {
    return {
      columns: { request_r2_key: null, response_r2_key: null },
      uploadError: String(error),
    };
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
