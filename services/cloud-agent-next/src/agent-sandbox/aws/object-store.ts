import { z } from 'zod';
import {
  createAwsClient,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';

export type AwsEc2ObjectStore = {
  putLaunch(key: string, body: string): Promise<void>;
  deleteLaunch(key: string): Promise<void>;
  launchExists(key: string): Promise<boolean>;
  cleanStopExists(key: string): Promise<boolean>;
  deleteCleanStop(key: string): Promise<void>;
};

/** Only the exact instance launch document and clean stop marker are accessible. */
export function createAwsObjectStore(input: {
  credentials: AwsCredentials;
  region: string;
  bucket: string;
  fetch?: AwsFetch;
}): AwsEc2ObjectStore {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket))
    throw new Error('Invalid AWS artifact bucket');
  const client = createAwsClient({ ...input, service: 's3' });
  function instanceTarget(key: string, prefix: 'launch' | 'stopped'): URL {
    const instanceKey = key.match(
      /^kilo\/(launch|stopped)\/arn:aws:ec2:([a-z0-9-]+):\d{12}:instance\/i-(?:[a-f0-9]{8}|[a-f0-9]{17})\/([a-f0-9-]+)\.json$/
    );
    if (
      instanceKey?.[1] !== prefix ||
      instanceKey[2] !== input.region ||
      !z.uuid().safeParse(instanceKey[3]).success
    )
      throw new Error('Invalid AWS EC2 object key');
    return new URL(`https://${input.bucket}.s3.${input.region}.amazonaws.com/${key}`);
  }
  async function exists(url: URL): Promise<boolean> {
    try {
      const response = await client.request(url, { method: 'HEAD' });
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof AwsRequestError && error.status === 404) return false;
      throw error;
    }
  }
  async function remove(url: URL): Promise<void> {
    const response = await client.request(url, { method: 'DELETE' });
    await response.body?.cancel();
  }
  return {
    launchExists: key => exists(instanceTarget(key, 'launch')),
    cleanStopExists: key => exists(instanceTarget(key, 'stopped')),
    deleteCleanStop: key => remove(instanceTarget(key, 'stopped')),
    async putLaunch(key, body) {
      if (new TextEncoder().encode(body).byteLength > 262_144)
        throw new Error('AWS launch document exceeds the size limit');
      const response = await client.request(instanceTarget(key, 'launch'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-none-match': '*' },
        body,
      });
      await response.body?.cancel();
    },
    deleteLaunch: key => remove(instanceTarget(key, 'launch')),
  };
}
