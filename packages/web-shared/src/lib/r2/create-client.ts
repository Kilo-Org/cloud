import { S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * Creates an S3 client for Cloudflare R2 in the `R2_ACCOUNT_ID` account.
 *
 * R2 is Cloudflare's S3-compatible object storage service.
 */
export function createR2Client(credentials: { accessKeyId: string; secretAccessKey: string }) {
  const accountId = getEnvVariable('R2_ACCOUNT_ID');
  if (!accountId) {
    throw new Error('R2_ACCOUNT_ID environment variable is required');
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials,
  });
}
