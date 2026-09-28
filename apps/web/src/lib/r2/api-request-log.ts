import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { ApiRequestLog } from '@kilocode/db/schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { r2Client } from '@/lib/r2/client';

export type ApiRequestLogBlobUpload = {
  columns: Pick<ApiRequestLog, 'request_r2_key' | 'response_r2_key'>;
  uploadError: string | null;
};

function getBucketName(): string {
  const bucketName = getEnvVariable('R2_API_REQUEST_LOG_BUCKET_NAME');
  if (!bucketName) {
    throw new Error('R2_API_REQUEST_LOG_BUCKET_NAME environment variable is required');
  }
  return bucketName;
}

async function putBlob(bucket: string, key: string, body: string, contentType: string) {
  await r2Client.send(
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
  let bucket: string;
  try {
    bucket = getBucketName();
  } catch (error) {
    return {
      columns: { request_r2_key: null, response_r2_key: null },
      uploadError: String(error),
    };
  }

  const prefix = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
  const [requestResult, responseResult] = await Promise.allSettled([
    putBlob(bucket, `${prefix}/request.json`, request, 'application/json; charset=utf-8'),
    response === undefined
      ? null
      : putBlob(bucket, `${prefix}/response.txt`, response, 'text/plain; charset=utf-8'),
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
    const result = await r2Client.send(new GetObjectCommand({ Bucket: getBucketName(), Key: key }));
    return (await result.Body?.transformToString('utf-8')) ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }
    throw error;
  }
}
