import { GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import type { ApiRequestLog } from '@kilocode/db/schema';
import { getEnvVariable } from '@/lib/dotenvx';
import { isUSRegion } from '@/lib/drizzle';
import { r2Client } from '@/lib/r2/client';

export type ApiRequestLogR2Region = NonNullable<ApiRequestLog['r2_region']>;

export type ApiRequestLogBlobs = {
  r2_region: ApiRequestLogR2Region;
  request_r2_key: string;
  response_r2_key: string | null;
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

export async function uploadApiRequestLogBlobs({
  request,
  response,
}: {
  request: string;
  response: string | undefined;
}): Promise<ApiRequestLogBlobs> {
  const r2_region = getApiRequestLogR2Region();
  const bucket = getBucketName(r2_region);
  const prefix = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;
  const request_r2_key = `${prefix}/request.json`;
  const response_r2_key = response === undefined ? null : `${prefix}/response.txt`;

  await Promise.all([
    r2Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: request_r2_key,
        Body: request,
        ContentType: 'application/json; charset=utf-8',
      })
    ),
    response_r2_key === null
      ? null
      : r2Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: response_r2_key,
            Body: response,
            ContentType: 'text/plain; charset=utf-8',
          })
        ),
  ]);

  return { r2_region, request_r2_key, response_r2_key };
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
