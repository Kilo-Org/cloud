import { describe, expect, it, vi } from 'vitest';
import { AWS_EC2_TAGS } from '@kilocode/worker-utils/aws-ec2';
import type { AwsEc2Instance, AwsEc2Snapshot } from '@kilocode/worker-utils/aws-ec2-client';
import { awsEc2FilesystemBase } from '../byoc/aws-ec2-provider.js';
import type { AwsEc2Workspace } from '../sandbox-control/aws-ec2-lifecycle.js';
import type { Env } from '../types.js';
import type { AwsEc2BuilderAllocation } from './aws-ec2-build-target.js';
import { createAwsEc2BuilderLifecycle } from './aws-ec2-builder.js';
import { createBuilderLifecycleState } from './builder-state.js';

const runtime = vi.hoisted(() => vi.fn());
vi.mock('../byoc/aws-ec2-runtime.js', () => ({
  createAwsEc2RuntimeAccess: () => runtime,
  prepareAwsEc2Host: vi.fn(),
}));

function fixture(clean: boolean) {
  const buildId = crypto.randomUUID();
  const allocationId = crypto.randomUUID();
  const generation = crypto.randomUUID();
  const captureId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const instanceId = 'i-0123456789abcdef0';
  const config: AwsEc2Workspace['config'] = {
    region: 'us-east-1',
    roleArn: 'arn:aws:iam::123456789012:role/sandbox-controller',
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
  const data = { id: 'vol-0123456789abcdef0', device: '/dev/sdf', deleteOnTermination: true };
  const root = { id: 'vol-0123456789abcdef1', device: '/dev/xvda', deleteOnTermination: true };
  const tags = new Map([
    [AWS_EC2_TAGS.installation, config.installation],
    [AWS_EC2_TAGS.generation, generation],
  ]);
  const instance: AwsEc2Instance = {
    id: instanceId,
    accountId: '123456789012',
    subnetId: config.subnetId,
    imageId: config.imageId,
    profileArn: config.instanceProfileArn,
    state: 'stopped',
    type: 'm7i.large',
    rootDevice: root.device,
    volumes: [root, data],
    publicIp: false,
    networkInterfaces: [{ id: 'eni-0123456789abcdef0', publicIp: false, hasIpv6: false }],
    securityGroups: [config.securityGroupId],
    metadata: { tokens: 'required', hopLimit: '1', instanceTags: 'enabled' },
    tags,
  };
  const snapshotId = 'snap-0123456789abcdef0';
  let snapshot: AwsEc2Snapshot | null = {
    id: snapshotId,
    accountId: instance.accountId,
    volumeId: data.id,
    encrypted: true,
    state: 'pending',
    tags: new Map([...tags, [AWS_EC2_TAGS.capture, captureId]]),
  };
  const ec2 = {
    describeInstance: async () => instance,
    describeVolume: async (id: string) =>
      instance.state === 'terminated'
        ? null
        : {
            id,
            state: 'in-use',
            tags,
            encrypted: true,
            attachments: [{ ...(id === root.id ? root : data), instanceId, state: 'attached' }],
          },
    generationVolumes: async () => [],
    terminate: vi.fn(async () => {
      instance.state = 'terminated';
    }),
    createSnapshot: vi.fn(async () => snapshot),
    findSnapshot: async () => snapshot,
    deleteSnapshot: vi.fn(async () => {
      snapshot = null;
    }),
  };
  runtime.mockResolvedValue({
    ec2,
    objects: {
      deleteLaunch: async () => {},
      cleanStopExists: async () => clean,
      deleteCleanStop: async () => {},
    },
  });
  const allocation: AwsEc2BuilderAllocation = {
    provider: 'aws-ec2',
    buildId,
    allocationId,
    environmentId: crypto.randomUUID(),
    sandboxId: 'ses-test',
    actorUserId: 'user-1',
    owner: { type: 'user', id: 'user-1' },
    target: {
      provider: 'aws-ec2',
      instance: 'aws-ec2-8g',
      credentialId,
      baseImage: awsEc2FilesystemBase(credentialId, config),
    },
  };
  const workspace: AwsEc2Workspace = {
    sandboxId: allocation.sandboxId,
    config,
    generation,
    phase: 'active',
    createdForAllocation: allocationId,
    allocation: { id: allocationId, startedAt: 10, document: 'ready' },
    instanceId,
    volumes: { root: root.id, data: data.id },
  };
  let stored: unknown = { format: 1, workspace };
  let now = 1000;
  const state = createBuilderLifecycleState({
    read: () => stored,
    write: value => {
      stored = structuredClone(value);
    },
    transaction: write => write(),
  });
  return {
    allocation,
    captureId,
    state,
    ec2,
    snapshotId,
    restart: () => createAwsEc2BuilderLifecycle({} as Env, () => now),
    complete() {
      if (snapshot) snapshot.state = 'completed';
    },
    afterReconciliationWindow() {
      now += 5 * 60_000;
    },
  };
}

describe('EC2 environment builder snapshot lifecycle', () => {
  it('publishes a completed snapshot and retains it after deleting the builder', async () => {
    const f = fixture(true);
    const { allocation, captureId, snapshotId, state } = f;
    expect(await f.restart().capture(allocation, captureId, state)).toEqual({
      status: 'in_progress',
    });
    f.complete();
    expect(await f.restart().capture(allocation, captureId, state)).toMatchObject({
      status: 'stored',
      snapshotId,
      baseImage: allocation.target.baseImage,
    });
    expect(f.ec2.createSnapshot).toHaveBeenCalledTimes(1);
    expect(await f.restart().stop(allocation, state, true)).toBe('retryable');
    expect(await f.restart().stop(allocation, state, true)).toBe('terminal');
    expect(f.ec2.deleteSnapshot).not.toHaveBeenCalled();
    expect(await f.restart().releaseSnapshot(allocation, state, snapshotId)).toBe('pending');
    f.afterReconciliationWindow();
    expect(await f.restart().releaseSnapshot(allocation, state, snapshotId)).toBe('done');
    expect(f.ec2.deleteSnapshot).toHaveBeenCalledExactlyOnceWith(snapshotId);
  });

  it('rejects capture when AWS stopped the builder without a host clean-stop marker', async () => {
    const f = fixture(false);
    expect(await f.restart().capture(f.allocation, f.captureId, f.state)).toEqual({
      status: 'failed',
      reason: 'snapshot_failed',
    });
    expect(f.ec2.createSnapshot).not.toHaveBeenCalled();
  });
});
