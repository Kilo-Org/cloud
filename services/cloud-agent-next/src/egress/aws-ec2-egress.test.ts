import { describe, expect, it, vi } from 'vitest';
import type { AwsEc2ByocConfiguration } from '@kilocode/worker-utils/aws-ec2';
import { awsEc2Ref, type AwsEc2Workspace } from '../sandbox-control/aws-ec2-lifecycle.js';
import { hashSandboxCredential } from '../sandbox-control/credential.js';
import type { ScopedScmGrant } from '../scm-broker/scoped-admission.js';
import type { Env } from '../types.js';
import { mintAwsEc2EgressCredential } from './aws-credential.js';
import { createAwsEgressIdentity, type AwsScopedEgressContext } from './aws-egress-identity.js';
import { awsEgressPolicy } from './aws-egress-policy.js';

async function fixture() {
  const now = 1_000_000;
  const expiresAt = now + 15_000;
  const secret = 'synthetic-signing-key';
  const hostProof = 'a'.repeat(64);
  const config: AwsEc2ByocConfiguration = {
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123456789012:role/controller',
    externalId: crypto.randomUUID(),
    stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test/12345678-abcd',
    bucket: 'sandbox-bucket',
    templateVersion: 1,
    subnetId: 'subnet-0123456789abcdef0',
    securityGroupId: 'sg-0123456789abcdef0',
    imageId: 'ami-0123456789abcdef0',
    instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/host',
    launchTemplateId: 'lt-0123456789abcdef0',
    launchTemplateVersion: 1,
    installation: crypto.randomUUID(),
  };
  const sandboxId = 'sbx-test';
  const allocationId = crypto.randomUUID();
  const instanceId = 'i-0123456789abcdef0';
  const generation = crypto.randomUUID();
  const workspace: AwsEc2Workspace = {
    sandboxId,
    config,
    generation,
    phase: 'starting',
    instanceId,
    createdForAllocation: allocationId,
    allocation: {
      id: allocationId,
      startedAt: now,
      egress: { expiresAt, identityHash: await hashSandboxCredential(hostProof) },
    },
  };
  const context: AwsScopedEgressContext<ScopedScmGrant> = {
    sandboxId,
    ownerId: 'user-1',
    provider: 'aws-ec2',
    byoc: { userId: 'user-1', credentialId: crypto.randomUUID() },
    available: true,
    containmentEnabled: true,
    allocation: { active: true, allocationId, providerRef: awsEc2Ref(workspace) },
    outboundContainerId: null,
    grants: [],
    liveMemberIds: [],
    identityBinding: 'session',
    audit: true,
    allowlist: ['example.com'],
    ec2: workspace,
  };
  const resolveEc2Configuration = vi.fn(async () => config);
  const identity = createAwsEgressIdentity<ScopedScmGrant, typeof context>({
    env: {} as Env,
    readContext: async () => context,
    serial: run => run(),
    resolveEc2Configuration,
    signingSecret: async () => secret,
    now: () => now,
  });
  function proof(hostInstanceId = instanceId) {
    return {
      identity: hostProof,
      credential: mintAwsEc2EgressCredential(
        {
          sandboxId,
          allocationId,
          generation,
          instanceId: hostInstanceId,
          stackId: config.stackId,
        },
        secret,
        expiresAt
      ),
    };
  }
  return { identity, proof, resolveEc2Configuration, config, context, workspace, expiresAt };
}

describe('EC2 host egress admission', () => {
  it('serves shared policy before wrapper admission and fences an already verified host after stop', async () => {
    const f = await fixture();
    const proof = f.proof();
    const response = await awsEgressPolicy(f.identity, proof, () => []);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      allocationRef: awsEc2Ref(f.workspace),
      validUntil: f.expiresAt,
      allowlist: ['example.com'],
      audit: true,
    });
    const verified = await f.identity.authenticate(f.context, proof);
    f.workspace.phase = 'stopping';
    await expect(f.identity.withCurrent(verified, () => true)).rejects.toMatchObject({
      code: 'allocation_unavailable',
    });
  });

  it('rejects credentials for another instance before reading the owner configuration', async () => {
    const f = await fixture();
    const response = await awsEgressPolicy(f.identity, f.proof('i-0123456789abcdef1'), () => []);
    expect(response.status).toBe(401);
    expect(f.resolveEc2Configuration).not.toHaveBeenCalled();
  });

  it('rejects a host if it uses an earlier enrollment configuration', async () => {
    const f = await fixture();
    f.resolveEc2Configuration.mockResolvedValue({ ...f.config, installation: crypto.randomUUID() });
    const response = await awsEgressPolicy(f.identity, f.proof(), () => []);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'connection_changed' });
  });
});
