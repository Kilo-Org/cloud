import {
  assumeAwsRole,
  createAwsClient,
  readAwsResponseBytes,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import { createAwsCloudformationClient } from '@kilocode/worker-utils/aws-cloudformation';
import {
  createAwsEgressMetadataReader,
  AwsEgressMetadataError,
} from '@kilocode/worker-utils/aws-egress-store';
import {
  AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
  awsByocConfigurationSchema,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import type { AwsSetupBinding } from '@kilocode/worker-utils/aws-onboarding';
import { assumeAwsKiloRole } from './aws-credential-resolver.js';
import { awsQuickCreateUrl } from './aws-setup-links.js';
import {
  readAwsSetupIntent,
  readReadyAwsConfiguration,
  requireAwsSetupEnrollment,
  type AwsSetupEnvironment,
} from './aws-setup-intent.js';
import {
  assertAwsAllocationStack,
  awsConfigurationFromSetupStack,
  AwsSetupError,
} from './aws-stack-validation.js';

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
  env: AwsSetupEnvironment,
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
  async function proxy(
    credentials: AwsCredentials,
    configuration: AwsByocConfiguration,
    hostname: string | undefined,
    signal: AbortSignal
  ) {
    if (!hostname) throw new AwsSetupError('byoc_aws_stack_mismatch');
    try {
      const metadata = await safeRead(
        () =>
          createAwsEgressMetadataReader({
            credentials,
            region: configuration.region,
            bucket: configuration.bucket,
            stackId: configuration.stackId,
            fetch: fetcher,
            now,
          })(signal),
        signal
      );
      const deployment = metadata.deployment;
      if (deployment.hostname !== hostname) throw new AwsSetupError('byoc_aws_stack_mismatch');
      if (Date.parse(deployment.expiresAt) <= now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000)
        throw new AwsSetupError('byoc_aws_proxy_expired');
      return {
        generation: deployment.generation,
        hostname: deployment.hostname,
        caFingerprint: deployment.caFingerprint,
      };
    } catch (error) {
      if (error instanceof AwsSetupError) throw error;
      if (error instanceof AwsEgressMetadataError && error.code === 'expired')
        throw new AwsSetupError('byoc_aws_proxy_expired');
      throw new AwsSetupError('byoc_aws_proxy_unavailable');
    }
  }
  return {
    async instructions(binding: AwsSetupBinding, envelope: unknown) {
      requireAwsSetupEnrollment(env, binding.owner);
      const intent = readAwsSetupIntent(env, binding, envelope);
      const signal = AbortSignal.timeout(30_000);
      const credentials = await kilo(signal);
      const client = createAwsClient({
        credentials,
        region: 'us-east-1',
        service: 's3',
        fetch: fetcher,
      });
      const source = new URL(
        `https://${intent.release.template.bucket}.s3.us-east-1.amazonaws.com/${intent.release.template.key}`
      );
      try {
        const response = await safeRead(() => client.request(source, { signal }), signal);
        const bytes = await readAwsResponseBytes(response, 1024 * 1024);
        if ((await checksum(bytes)) !== intent.release.template.sha256)
          throw new Error('Template checksum mismatch');
        const url = await client.signedUrl(source, 'GET', TEMPLATE_LINK_TTL_SECONDS);
        signal.throwIfAborted();
        return {
          launchUrl: awsQuickCreateUrl(intent, url),
          accountId: intent.accountId,
          stackName: intent.stackName,
          templateVersion: intent.release.templateVersion,
          expiresAt: new Date(now() + TEMPLATE_LINK_TTL_SECONDS * 1000).toISOString(),
        };
      } catch {
        throw new AwsSetupError('byoc_aws_setup_unavailable');
      }
    },
    async validate(
      binding: AwsSetupBinding,
      envelope: unknown,
      roleArn: string
    ): Promise<AwsByocConfiguration> {
      requireAwsSetupEnrollment(env, binding.owner);
      const intent = readAwsSetupIntent(env, binding, envelope);
      if (roleArn.split(':')[4] !== intent.accountId)
        throw new AwsSetupError('byoc_aws_stack_mismatch');
      const signal = AbortSignal.timeout(45_000);
      const credentials = await customer(roleArn, intent.externalId, signal);
      const current = await stack(credentials, intent.stackName, signal);
      const configuration = awsConfigurationFromSetupStack({ intent, roleArn, stack: current });
      const pin = await proxy(credentials, configuration, current.outputs.ProxyHostname, signal);
      signal.throwIfAborted();
      return awsByocConfigurationSchema.parse({ ...configuration, proxy: pin });
    },
    async revalidate(binding: AwsSetupBinding, envelope: unknown, roleArn: string): Promise<void> {
      requireAwsSetupEnrollment(env, binding.owner);
      const configuration = readReadyAwsConfiguration(env, binding, envelope);
      if (roleArn !== configuration.roleArn)
        throw new AwsSetupError('byoc_aws_connection_update_required');
      const signal = AbortSignal.timeout(45_000);
      const credentials = await customer(roleArn, configuration.externalId, signal);
      const current = await stack(credentials, configuration.stackId, signal);
      try {
        assertAwsAllocationStack(current, configuration);
      } catch (error) {
        if (error instanceof AwsSetupError && error.code === 'byoc_aws_stack_mismatch')
          throw new AwsSetupError('byoc_aws_connection_update_required');
        throw error;
      }
      const pin = await proxy(credentials, configuration, current.outputs.ProxyHostname, signal);
      if (!configuration.proxy || JSON.stringify(pin) !== JSON.stringify(configuration.proxy))
        throw new AwsSetupError('byoc_aws_connection_update_required');
      signal.throwIfAborted();
    },
  };
}
