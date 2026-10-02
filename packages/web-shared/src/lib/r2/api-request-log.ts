import { GetObjectCommand, NoSuchKey, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { ApiRequestLog } from '@kilocode/db/schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { createR2Client } from '@/lib/r2/client';

export type ApiRequestLogBlobUpload = {
  columns: Pick<ApiRequestLog, 'request_r2_key' | 'response_r2_key'>;
  uploadError: string | null;
};

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

async function putBlob(
  { client, bucket }: ApiRequestLogStorage,
  key: string,
  body: string,
  contentType: string
) {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType })
  );
  return key;
}

/**
 * Never throws. Each body is uploaded independently, so the key of every
 * object that was written is returned even when the other upload fails;
 * this keeps all written objects referenced by their row.
 */
export async function uploadApiRequestLogBlobs({
  request,
  response,
}: {
  request: string;
  response: string | undefined;
}): Promise<ApiRequestLogBlobUpload> {
  let resolvedStorage: ApiRequestLogStorage;
  try {
    resolvedStorage = getStorage();
  } catch (error) {
    return {
      columns: { request_r2_key: null, response_r2_key: null },
      uploadError: String(error),
    };
  }

  const prefix = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
  const [requestResult, responseResult] = await Promise.allSettled([
    putBlob(resolvedStorage, `${prefix}/request.json`, request, 'application/json; charset=utf-8'),
    response === undefined
      ? null
      : putBlob(resolvedStorage, `${prefix}/response.txt`, response, 'text/plain; charset=utf-8'),
  ]);

  const uploadErrors = [
    requestResult.status === 'rejected' ? `request: ${String(requestResult.reason)}` : null,
    responseResult.status === 'rejected' ? `response: ${String(responseResult.reason)}` : null,
  ].filter(error => error !== null);

  return {
    columns: {
      request_r2_key: requestResult.status === 'fulfilled' ? requestResult.value : null,
      response_r2_key: responseResult.status === 'fulfilled' ? responseResult.value : null,
    },
    uploadError: uploadErrors.length > 0 ? uploadErrors.join('; ') : null,
  };
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
