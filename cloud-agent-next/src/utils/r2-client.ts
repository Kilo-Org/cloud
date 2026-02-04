import { AwsClient } from 'aws4fetch';

export type R2ClientConfig = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
};

export type R2Client = {
  getSignedURL: (bucket: string, path: string, expiresIn?: number) => Promise<string>;
};

/**
 * Create an R2 client that generates presigned URLs for object access.
 */
export function createR2Client(config: R2ClientConfig): R2Client {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  return {
    /**
     * Generate a presigned URL for downloading an object from R2.
     *
     * @param bucket - The R2 bucket name
     * @param path - The object key/path within the bucket
     * @param expiresIn - URL expiration time in seconds (default: 3600 = 1 hour)
     * @returns Presigned URL for GET access to the object
     */
    async getSignedURL(bucket: string, path: string, expiresIn: number = 3600): Promise<string> {
      const url = new URL(`/${bucket}/${path}`, config.endpoint);
      url.searchParams.set('X-Amz-Expires', String(expiresIn));

      const signedRequest = await aws.sign(url.toString(), {
        method: 'GET',
        aws: { signQuery: true },
      });

      return signedRequest.url;
    },
  };
}
