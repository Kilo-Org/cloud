import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { createR2S3Client as CreateR2S3Client } from './create-r2-s3-client';

jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation((config: unknown) => ({ config })),
}));

let createR2S3Client: typeof CreateR2S3Client;
let MockS3Client: jest.Mock;

describe('createR2S3Client', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    const aws = await import('@aws-sdk/client-s3');
    const client = await import('./create-r2-s3-client');
    MockS3Client = aws.S3Client as unknown as jest.Mock;
    createR2S3Client = client.createR2S3Client;
  });

  it('disables flexible checksums so browser PUTs are not signed with empty-body CRC32', () => {
    createR2S3Client({
      accountId: 'deadbeef',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });

    expect(MockS3Client).toHaveBeenCalledWith({
      region: 'auto',
      endpoint: 'https://deadbeef.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });
});
