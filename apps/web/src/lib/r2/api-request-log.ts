import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { ApiRequestLog } from '@kilocode/db/schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { isUSRegion } from '@/lib/drizzle';
import { r2Client } from '@/lib/r2/client';

export type ApiRequestLogR2Region = NonNullable<ApiRequestLog['r2_region']>;

export type ApiRequestLogBlobUpload = {
  columns: Pick<ApiRequestLog, 'r2_region' | 'request_r2_key' | 'response_r2_key'>;
  uploadError: string | null;
};

function getBucketName(region: ApiRequestLogR2Region): string {
  const variableName =
    region === 'us' ? 'R2_API_REQUEST_LOG_US_BUCKET_NAME' : 'R2_API_REQUEST_LOG_EU_BUCKET_NAME';
  const bucketName = getEnvVariable(variableName);
  if (!bucketName) {
    throw new Error(`${variableName} environment variable is required`);
  }
  return bucketName;
}

/** The SFO deployment writes to the US bucket; every other region writes to the EU bucket. */
export function getApiRequestLogR2Region(): ApiRequestLogR2Region {
  return isUSRegion(process.env.VERCEL_REGION) ? 'us' : 'eu';
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
  const r2_region = getApiRequestLogR2Region();
  let bucket: string;
  try {
    bucket = getBucketName(r2_region);
  } catch (error) {
    return {
      columns: { r2_region: null, request_r2_key: null, response_r2_key: null },
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

  const request_r2_key = requestResult.status === 'fulfilled' ? requestResult.value : null;
  const response_r2_key = responseResult.status === 'fulfilled' ? responseResult.value : null;
  const uploadErrors = [
    requestResult.status === 'rejected' ? `request: ${String(requestResult.reason)}` : null,
    responseResult.status === 'rejected' ? `response: ${String(responseResult.reason)}` : null,
  ].filter(error => error !== null);

  return {
    columns: {
      r2_region: request_r2_key === null && response_r2_key === null ? null : r2_region,
      request_r2_key,
      response_r2_key,
    },
    uploadError: uploadErrors.length > 0 ? uploadErrors.join('; ') : null,
  };
}

/** Returns null when the object does not exist. */
export async function getApiRequestLogBlob(
  region: ApiRequestLogR2Region,
  key: string
): Promise<string | null> {
  try {
    const result = await r2Client.send(
      new GetObjectCommand({ Bucket: getBucketName(region), Key: key })
    );
    return (await result.Body?.transformToString('utf-8')) ?? null;
  } catch (error) {
    if (error instanceof NoSuchKey) {
      return null;
    }
    throw error;
  }
}
