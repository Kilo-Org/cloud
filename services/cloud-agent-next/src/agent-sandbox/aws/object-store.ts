import { z } from 'zod';
import {
  createAwsClient,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';

export type AwsObjectStore = {
  putLaunch(key: string, body: string): Promise<void>;
  deleteLaunch(key: string): Promise<void>;
  downloadUrl(key: string, expiresInSeconds: number): Promise<string>;
  prepareArchiveUpload(
    key: string,
    sha256: string,
    expiresInSeconds: number
  ): Promise<{ url: string; headers: Record<string, string> }>;
  inspectArchive(key: string): Promise<{ size: number; sha256: string } | null>;
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
      !/^kilo\/(launch|archives)\/[A-Za-z0-9_/-]+\.(json|tar|tar\.gz)$/.test(key) ||
      key.includes('//')
    )
      throw new Error('Invalid AWS artifact key');
    return new URL(`https://${input.bucket}.s3.${input.region}.amazonaws.com/${key}`);
  }
  function launchTarget(key: string): URL {
    if (!/^kilo\/launch\/[A-Za-z0-9_-]+\.json$/.test(key))
      throw new Error('Invalid AWS launch key');
    return target(key);
  }
  function archiveTarget(key: string): URL {
    if (!/^kilo\/archives\/[A-Za-z0-9_/-]+\.tar(?:\.gz)?$/.test(key))
      throw new Error('Invalid AWS archive key');
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
    async prepareArchiveUpload(key, sha256, seconds) {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid AWS archive checksum');
      const bytes = Uint8Array.from(sha256.match(/../g) ?? [], value => Number.parseInt(value, 16));
      const checksum = btoa(String.fromCharCode(...bytes));
      const headers = {
        'content-type': 'application/x-tar',
        'if-none-match': '*',
        'x-amz-checksum-sha256': checksum,
      };
      return { url: await client.signedUrl(archiveTarget(key), 'PUT', seconds, headers), headers };
    },
    async inspectArchive(key) {
      try {
        const response = await client.request(archiveTarget(key), {
          method: 'HEAD',
          headers: { 'x-amz-checksum-mode': 'ENABLED' },
        });
        const size = z
          .number()
          .int()
          .nonnegative()
          .safeParse(Number(response.headers.get('content-length')));
        const checksum = response.headers.get('x-amz-checksum-sha256');
        const bytes =
          checksum && /^[A-Za-z0-9+/]{43}=$/.test(checksum)
            ? Uint8Array.from(atob(checksum), value => value.charCodeAt(0))
            : null;
        await response.body?.cancel();
        if (
          !size.success ||
          !response.headers.has('content-length') ||
          !bytes ||
          bytes.length !== 32
        )
          throw new AwsRequestError(0, 'InvalidArchiveMetadata');
        return {
          size: size.data,
          sha256: Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(''),
        };
      } catch (error) {
        if (error instanceof AwsRequestError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
