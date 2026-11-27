import { describe, expect, it, vi } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { AwsEgressMetadataError } from '@kilocode/worker-utils/aws-egress-store';
import { AWS_TEST_CONFIGURATION } from '../../test/fixtures/aws-provider.js';
import {
  mintSandboxLaunchCredential,
  verifySandboxLaunchCredential,
} from '../sandbox-control/credential.js';
import { verifyAwsEgressCredential } from '../egress/aws-credential.js';
import { prepareAwsProxyStartup, readPinnedAwsProxyDeployment } from './aws-proxy.js';

const secret = 'worker-test-key';
const generation = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
const sandboxId = 'sbx_test_aws';
const configuration = {
  ...AWS_TEST_CONFIGURATION,
  proxy: { generation, hostname: 'proxy.kilo.internal', caFingerprint: 'b'.repeat(64) },
};
function metadata() {
  return {
    deployment: {
      protocolVersion: 1 as const,
      generation,
      stackId: configuration.stackId,
      hostname: configuration.proxy.hostname,
      port: 3128 as const,
      caCertificate: 'public-certificate'.repeat(10),
      caFingerprint: configuration.proxy.caFingerprint,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
    identity: {
      protocolVersion: 1 as const,
      generation,
      stackId: configuration.stackId,
      secret: 'c'.repeat(64),
    },
  };
}
function fixture() {
  const value = metadata();
  return {
    configuration,
    readMetadata: vi.fn(async () => value),
    signingSecret: secret,
    ref: { provider: 'aws' as const, sandboxId, intentId: allocationId, createdAt: Date.now() },
    startup: {
      command: { argv: ['/bin/echo', 'hello'] },
      env: {
        SANDBOX_CONTROL_CREDENTIAL: mintSandboxLaunchCredential(
          { sandboxId, allocationId, credential: 'a'.repeat(64) },
          secret
        ),
      },
    },
  };
}
describe('AWS proxy launch admission', () => {
  it('adds a separate allocation credential and public CA without sharing proxy identity', async () => {
    const input = fixture();
    const result = await prepareAwsProxyStartup(input);
    const proxy = new URL(result.env.HTTPS_PROXY);
    expect(proxy.hostname).toBe(configuration.proxy.hostname);
    expect(proxy.port).toBe('3128');
    expect(verifyAwsEgressCredential(proxy.password, secret)).toMatchObject({
      sandboxId,
      allocationId,
      generation,
    });
    expect(verifySandboxLaunchCredential(proxy.password, secret)).toBeNull();
    expect(result.env.KILO_AWS_EGRESS_CA_CERTIFICATE).toBe(metadata().deployment.caCertificate);
    expect(JSON.stringify(result)).not.toContain(metadata().identity.secret);
    expect(result.command).toBe(input.startup.command);
    expect(input.startup.env).not.toHaveProperty('HTTPS_PROXY');
  });
  it('refuses an expired generation and a mismatched allocation before launch', async () => {
    const expired = fixture();
    expired.readMetadata.mockResolvedValue({
      ...metadata(),
      deployment: {
        ...metadata().deployment,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    await expect(prepareAwsProxyStartup(expired)).rejects.toMatchObject({
      reason: 'byoc_aws_proxy_expired',
    });
    const wrong = fixture();
    wrong.ref.intentId = '33333333-3333-4333-8333-333333333333';
    await expect(prepareAwsProxyStartup(wrong)).rejects.toMatchObject({
      reason: 'byoc_aws_connection_changed',
    });
  });
  it('fails closed for missing pins and changed deployment identity', async () => {
    const read = vi.fn(async () => metadata());
    await expect(readPinnedAwsProxyDeployment(AWS_TEST_CONFIGURATION, read)).rejects.toMatchObject({
      reason: 'byoc_aws_stack_outdated',
    });
    expect(read).not.toHaveBeenCalled();
    for (const field of ['generation', 'hostname', 'caFingerprint', 'stackId'] as const) {
      const changed = metadata();
      changed.deployment[field] = 'wrong';
      await expect(
        readPinnedAwsProxyDeployment(configuration, async () => changed)
      ).rejects.toMatchObject({ reason: 'byoc_aws_connection_changed' });
    }
  });
  it('retries only transient reads and keeps denied access specific', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new AwsRequestError(503, 'ServiceUnavailable'))
      .mockResolvedValue(metadata());
    await expect(readPinnedAwsProxyDeployment(configuration, read)).resolves.toMatchObject({
      deployment: { generation },
    });
    expect(read).toHaveBeenCalledTimes(2);
    for (const [error, reason] of [
      [new AwsRequestError(403, 'AccessDenied'), 'byoc_aws_forbidden'],
      [new AwsEgressMetadataError('expired'), 'byoc_aws_proxy_expired'],
      [new AwsEgressMetadataError('invalid'), 'byoc_aws_connection_changed'],
    ] as const) {
      const denied = vi.fn().mockRejectedValue(error);
      await expect(readPinnedAwsProxyDeployment(configuration, denied)).rejects.toMatchObject({
        reason,
      });
      expect(denied).toHaveBeenCalledTimes(1);
    }
  });
});
