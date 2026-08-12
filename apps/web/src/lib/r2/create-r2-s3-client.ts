import { S3Client } from '@aws-sdk/client-s3';

export type R2S3ClientCredentials = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export function createR2S3Client({
  accountId,
  accessKeyId,
  secretAccessKey,
}: R2S3ClientCredentials): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
