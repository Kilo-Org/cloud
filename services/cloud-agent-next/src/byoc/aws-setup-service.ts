import {
  assumeAwsRole,
  createAwsClient,
  readAwsResponseBytes,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import { createAwsCloudformationClient } from '@kilocode/worker-utils/aws-cloudformation';
import { assumeAwsKiloRole } from './aws-account-access.js';
import { AwsSetupError } from './aws-errors.js';
import type { Env } from '../types.js';

const TEMPLATE_LINK_TTL_SECONDS = 900;
function transient(error: unknown): boolean {
  return (
    error instanceof AwsRequestError &&
    (error.status === 0 || error.status === 429 || error.status >= 500)
  );
}
async function safeRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      signal.throwIfAborted();
      if (!transient(error) || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, [100, 250][attempt]));
    }
  }
}
function checksum(bytes: Uint8Array): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', bytes)
    .then(value =>
      Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('')
    );
}

/** One request-scoped service. AWS credentials and proxy shared identity never enter its public results. */
export function createAwsSetupService(
  env: Pick<Env, 'AWS_BYOC_CREDENTIALS' | 'AWS_BYOC_KILO_ROLE_ARN'>,
  input: { fetch?: AwsFetch; now?: () => number } = {}
) {
  const fetcher = input.fetch ?? fetch;
  const now = input.now ?? Date.now;
  async function kilo(signal: AbortSignal) {
    try {
      return await safeRead(() => assumeAwsKiloRole(env, fetcher, signal), signal);
    } catch {
      throw new AwsSetupError('byoc_aws_setup_unavailable');
    }
  }
  async function customer(
    roleArn: string,
    externalId: string,
    signal: AbortSignal
  ): Promise<AwsCredentials> {
    const credentials = await kilo(signal);
    const role = (externalId?: string) =>
      assumeAwsRole({
        credentials,
        region: 'us-east-1',
        roleArn,
        externalId,
        fetch: fetcher,
        signal,
      });
    let granted: AwsCredentials;
    try {
      granted = await safeRead(() => role(externalId), signal);
    } catch (error) {
      // A timeout or AWS outage is not a trust-policy problem the customer can fix.
      if (signal.aborted || transient(error)) throw new AwsSetupError('byoc_aws_setup_unavailable');
      throw new AwsSetupError('byoc_aws_role_unavailable');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    let wrongId = Array.from(bytes, value => (value % 16).toString(16))
      .join('')
      .repeat(2)
      .slice(0, externalId.length);
    if (wrongId === externalId) wrongId = (externalId[0] === 'a' ? 'b' : 'a') + externalId.slice(1);
    const probes = await Promise.allSettled([
      safeRead(() => role(), signal),
      safeRead(() => role(wrongId), signal),
    ]);
    if (probes.some(probe => probe.status === 'fulfilled'))
      throw new AwsSetupError('byoc_aws_external_id_not_enforced');
    if (
      signal.aborted ||
      probes.some(probe => probe.status === 'rejected' && transient(probe.reason))
    )
      throw new AwsSetupError('byoc_aws_setup_unavailable');
    if (
      probes.some(
        probe =>
          probe.status === 'rejected' &&
          !(probe.reason instanceof AwsRequestError && probe.reason.status === 403)
      )
    )
      throw new AwsSetupError('byoc_aws_role_unavailable');
    signal.throwIfAborted();
    return granted;
  }
  async function stack(credentials: AwsCredentials, identity: string, signal: AbortSignal) {
    try {
      return await safeRead(
        () =>
          createAwsCloudformationClient({
            credentials,
            region: 'us-east-1',
            fetch: fetcher,
          }).describeStack(identity, signal),
        signal
      );
    } catch {
      throw new AwsSetupError('byoc_aws_stack_unavailable');
    }
  }
  async function signedTemplate(
    template: { bucket: string; key: string; sha256: string },
    signal: AbortSignal
  ) {
    const credentials = await kilo(signal);
    const client = createAwsClient({
      credentials,
      region: 'us-east-1',
      service: 's3',
      fetch: fetcher,
    });
    const source = new URL(`https://${template.bucket}.s3.us-east-1.amazonaws.com/${template.key}`);
    try {
      const response = await safeRead(() => client.request(source, { signal }), signal);
      const bytes = await readAwsResponseBytes(response, 1024 * 1024);
      if ((await checksum(bytes)) !== template.sha256)
        throw new Error('Template checksum mismatch');
      const url = await client.signedUrl(source, 'GET', TEMPLATE_LINK_TTL_SECONDS);
      signal.throwIfAborted();
      return { url, expiresAt: new Date(now() + TEMPLATE_LINK_TTL_SECONDS * 1000).toISOString() };
    } catch {
      throw new AwsSetupError('byoc_aws_setup_unavailable');
    }
  }
  return { customer, stack, signedTemplate };
}
