import {
  createAwsClient,
  AwsRequestError,
  readAwsResponse,
  type AwsCredentials,
  type AwsFetch,
} from './aws-client';
import {
  AWS_EGRESS_PUBLIC_KEY,
  AWS_EGRESS_SHARED_KEY,
  awsEgressPublicDeploymentSchema,
  awsEgressSharedIdentitySchema,
} from './aws-egress';
import { sha256Hex } from './sha256';

export class AwsEgressMetadataError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'invalid'
      | 'identity_mismatch'
      | 'expired'
      | 'certificate_mismatch'
  ) {
    super(`AWS proxy metadata failed (${code})`);
    this.name = 'AwsEgressMetadataError';
  }
}

/** Read only the deployment's public CA and shared proxy identity. This API cannot select private keys. */
export function createAwsEgressMetadataReader(input: {
  credentials: AwsCredentials;
  region: string;
  bucket: string;
  stackId: string;
  fetch?: AwsFetch;
  now?: () => number;
}) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(input.bucket))
    throw new Error('Invalid AWS proxy bucket');
  const client = createAwsClient({ ...input, service: 's3' });
  const now = input.now ?? Date.now;
  async function read(
    key: typeof AWS_EGRESS_PUBLIC_KEY | typeof AWS_EGRESS_SHARED_KEY,
    signal?: AbortSignal
  ) {
    const response = await client.request(
      `https://${input.bucket}.s3.${input.region}.amazonaws.com/${key}`,
      { signal }
    );
    return JSON.parse(await readAwsResponse(response, 32_768)) as unknown;
  }
  return async (signal?: AbortSignal) => {
    try {
      const [publicValue, sharedValue] = await Promise.all([
        read(AWS_EGRESS_PUBLIC_KEY, signal),
        read(AWS_EGRESS_SHARED_KEY, signal),
      ]);
      const parsedDeployment = awsEgressPublicDeploymentSchema.safeParse(publicValue);
      const parsedIdentity = awsEgressSharedIdentitySchema.safeParse(sharedValue);
      if (!parsedDeployment.success || !parsedIdentity.success)
        throw new AwsEgressMetadataError('invalid');
      const deployment = parsedDeployment.data;
      const identity = parsedIdentity.data;
      if (
        deployment.stackId !== input.stackId ||
        identity.stackId !== input.stackId ||
        deployment.generation !== identity.generation ||
        deployment.protocolVersion !== identity.protocolVersion
      )
        throw new AwsEgressMetadataError('identity_mismatch');
      if (Date.parse(deployment.expiresAt) <= now()) throw new AwsEgressMetadataError('expired');
      if ((await sha256Hex(deployment.caCertificate)) !== deployment.caFingerprint)
        throw new AwsEgressMetadataError('certificate_mismatch');
      return { deployment, identity };
    } catch (error) {
      if (error instanceof AwsRequestError || error instanceof AwsEgressMetadataError) throw error;
      throw new AwsEgressMetadataError('unavailable');
    }
  };
}
