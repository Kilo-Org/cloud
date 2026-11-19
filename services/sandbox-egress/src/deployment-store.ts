import {
  createAwsClient,
  AwsRequestError,
  readAwsResponse,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import { AWS_EGRESS_PUBLIC_KEY, AWS_EGRESS_SHARED_KEY } from '@kilocode/worker-utils/aws-egress';
import type { ProxyDeploymentStore } from './deployment.js';

const privateKey = 'kilo/proxy/private/material.json';

export function createProxyDeploymentStore(input: {
  credentials: AwsCredentials;
  region: string;
  bucket: string;
  fetch?: AwsFetch;
}): ProxyDeploymentStore {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket))
    throw new Error('Invalid AWS proxy bucket');
  const client = createAwsClient({ ...input, service: 's3' });
  const target = (key: string) => `https://${input.bucket}.s3.${input.region}.amazonaws.com/${key}`;
  async function publish(key: string, value: unknown, headers: Record<string, string> = {}) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 32_768)
      throw new Error('AWS proxy material exceeds its size limit');
    const response = await client.request(target(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    await response.body?.cancel();
  }
  return {
    async readPrivate() {
      try {
        const response = await client.request(target(privateKey));
        return JSON.parse(await readAwsResponse(response, 32_768)) as unknown;
      } catch (error) {
        if (error instanceof AwsRequestError && error.status === 404) return undefined;
        throw error;
      }
    },
    async putPrivateOnce(value) {
      try {
        await publish(privateKey, value, { 'If-None-Match': '*' });
        return 'stored';
      } catch (error) {
        if (error instanceof AwsRequestError && error.status === 412) return 'exists';
        throw error;
      }
    },
    publishPublic: value => publish(AWS_EGRESS_PUBLIC_KEY, value),
    publishIdentity: value => publish(AWS_EGRESS_SHARED_KEY, value),
  };
}
