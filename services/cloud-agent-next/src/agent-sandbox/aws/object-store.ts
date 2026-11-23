import {
  createAwsClient,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';

export type AwsObjectStore = {
  putLaunch(key: string, body: string): Promise<void>;
  deleteLaunch(key: string): Promise<void>;
  downloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  uploadUrl(key: string, expiresInSeconds: number): Promise<string>;
};

/** Launch documents and prepared archives share transport, but never proxy-private prefixes. */
export function createAwsObjectStore(input: {
  credentials: AwsCredentials;
  region: string;
  bucket: string;
  fetch?: AwsFetch;
}): AwsObjectStore {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket))
    throw new Error('Invalid AWS artifact bucket');
  const client = createAwsClient({ ...input, service: 's3' });
  function target(key: string): URL {
    if (
      !/^kilo\/(launch|archives)\/[A-Za-z0-9_/-]+\.(json|tar\.gz)$/.test(key) ||
      key.includes('//')
    )
      throw new Error('Invalid AWS artifact key');
    return new URL(`https://${input.bucket}.s3.${input.region}.amazonaws.com/${key}`);
  }
  function launchTarget(key: string): URL {
    if (!key.startsWith('kilo/launch/')) throw new Error('Invalid AWS launch key');
    return target(key);
  }
  return {
    async putLaunch(key, body) {
      if (new TextEncoder().encode(body).byteLength > 262_144)
        throw new Error('AWS launch document exceeds the size limit');
      const response = await client.request(launchTarget(key), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body,
      });
      await response.body?.cancel();
    },
    async deleteLaunch(key) {
      const response = await client.request(launchTarget(key), { method: 'DELETE' });
      await response.body?.cancel();
    },
    async downloadUrl(key, seconds) {
      return client.signedUrl(target(key), 'GET', seconds);
    },
    async uploadUrl(key, seconds) {
      if (!key.startsWith('kilo/archives/')) throw new Error('Invalid AWS archive key');
      return client.signedUrl(target(key), 'PUT', seconds);
    },
  };
}
