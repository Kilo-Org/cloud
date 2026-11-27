import { describe, expect, it, vi } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { AWS_EC2_TAGS, awsEc2ByocConfigurationSchema } from '@kilocode/worker-utils/aws-ec2';
import type {
  AwsEc2Client,
  AwsEc2Instance,
  AwsEc2Snapshot,
} from '@kilocode/worker-utils/aws-ec2-client';
import {
  awsEc2LaunchKey,
  createAwsEc2Lifecycle,
  type AwsEc2Workspace,
} from './aws-ec2-lifecycle.js';
import { createAwsEc2SnapshotCapture, type AwsEc2SnapshotOperation } from './aws-ec2-snapshot.js';

const config = awsEc2ByocConfigurationSchema.parse({
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/customer',
  externalId: '00000000000000000000000000000001',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  bucket: 'sandbox-bucket',
  templateVersion: 1,
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  imageId: 'ami-0123456789abcdef0',
  instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/host',
  launchTemplateId: 'lt-0123456789abcdef0',
  launchTemplateVersion: 4,
  installation: '52ba9247-26af-434a-8dd7-ae70cc4cac47',
});
const firstAllocation = '1f9c29e6-4414-45b7-ae8f-2955a3557567';
const nextAllocation = 'a1739729-dee2-44da-84cd-0f942626147c';
const instanceId = 'i-0123456789abcdef0';
const data = { id: 'vol-0123456789abcdef0', device: '/dev/sdf', deleteOnTermination: true };
const root = { id: 'vol-0123456789abcdef1', device: '/dev/sda1', deleteOnTermination: true };
const snapshot = 'snap-0123456789abcdef0';
const startup = { command: { argv: ['start'] }, env: { GRANT: 'synthetic' } };

function fixture(assertLaunchActive?: () => void) {
  const events: string[] = [];
  const documents = new Map<string, string>();
  let workspace: AwsEc2Workspace | undefined;
  let vm: AwsEc2Instance | null = null;
  let volumesRemain = false;
  let encrypted = true;
  const describeVolume = vi.fn<AwsEc2Client['describeVolume']>(async id => {
    if (!vm || !volumesRemain) return null;
    const device = id === data.id ? data : root;
    return {
      id,
      encrypted,
      state: 'in-use',
      tags: vm.tags,
      attachments: [{ ...device, instanceId, state: 'attached' }],
    };
  });
  const ec2 = {
    describeInstance: vi.fn(async () => vm),
    findGeneration: vi.fn(async () => vm),
    generationVolumes: vi.fn<AwsEc2Client['generationVolumes']>(async () => {
      const volume = await describeVolume(data.id);
      return volume ? [volume] : [];
    }),
    deleteVolume: vi.fn(async () => {}),
    runInstance: vi.fn(async (_config: typeof config, generation: string, _snapshot?: string) => {
      events.push('run');
      vm = {
        accountId: '123456789012',
        id: instanceId,
        state: 'running',
        type: 'm7i.large',
        imageId: config.imageId,
        subnetId: config.subnetId,
        rootDevice: root.device,
        volumes: [root, data],
        networkInterfaces: [{ id: 'eni-0123456789abcdef0', publicIp: false, hasIpv6: false }],
        publicIp: false,
        securityGroups: [config.securityGroupId],
        profileArn: config.instanceProfileArn,
        metadata: { tokens: 'required', hopLimit: '1', instanceTags: 'enabled' },
        tags: new Map([
          [AWS_EC2_TAGS.installation, config.installation],
          [AWS_EC2_TAGS.generation, generation],
        ]),
      };
      volumesRemain = true;
      return vm;
    }),
    describeVolume,
    setAllocation: vi.fn(async (_id: string, allocation: string) => {
      events.push('tag');
      vm?.tags.set(AWS_EC2_TAGS.allocation, allocation);
    }),
    start: vi.fn(async () => {
      events.push('start');
      return 'pending' as const;
    }),
    stop: vi.fn(async () => 'stopping' as const),
    terminate: vi.fn(async () => 'shutting-down' as const),
  };
  const objects = {
    putLaunch: vi.fn(async (key: string, body: string) => {
      events.push('upload');
      documents.set(key, body);
    }),
    deleteLaunch: vi.fn(async (key: string) => {
      documents.delete(key);
    }),
    launchExists: vi.fn(async (key: string) => documents.has(key)),
    cleanStopExists: vi.fn(async () => false),
    deleteCleanStop: vi.fn(async () => {}),
  };
  const deps = {
    sandboxId: 'sbx_test',
    assertLaunchActive,
    storage: {
      get: async () => workspace,
      put: async (value: AwsEc2Workspace) => {
        workspace = structuredClone(value);
      },
      delete: async () => {
        workspace = undefined;
      },
    },
    configuration: async () => config,
    runtime: async () => ({ ec2, objects }),
    prepareHost: async (workspace: AwsEc2Workspace) => ({
      instanceId,
      dataVolumeId: data.id,
      dataVolumeAction: 'initialize' as const,
      allocationId: workspace.allocation.id,
      sandboxId: 'sbx_test',
      expiresAt: 60_000,
      origin: 'https://agent.example.com',
      identity: {
        protocolVersion: 1 as const,
        generation: workspace.generation,
        stackId: config.stackId,
        secret: 'a'.repeat(64),
      },
      token: 'signed-host-token',
    }),
    now: () => 1000,
  };
  return {
    controller: createAwsEc2Lifecycle(deps),
    restartController: () => createAwsEc2Lifecycle(deps),
    workspace: () => awsEc2Workspace(),
    events,
    ec2,
    objects,
    documents,
    state(state: AwsEc2Instance['state']) {
      if (!vm) throw new Error('Test VM missing');
      vm.state = state;
    },
    deleteTestVolumes() {
      volumesRemain = false;
    },
    makeUnencrypted() {
      encrypted = false;
    },
  };

  function awsEc2Workspace() {
    if (!workspace) throw new Error('Test workspace missing');
    return workspace;
  }
}

describe('EC2 retained workspace lifecycle', () => {
  it('does not submit a builder VM after cancellation during an AWS read', async () => {
    let active = true;
    const f = fixture(() => {
      if (!active) throw new Error('Build cancelled');
    });
    const ref = await f.controller.reserve(firstAllocation);
    f.ec2.findGeneration.mockImplementationOnce(async () => {
      active = false;
      return null;
    });
    await expect(f.controller.launch(ref, startup, 5000)).rejects.toThrow('Build cancelled');
    expect(f.ec2.runInstance).not.toHaveBeenCalled();
    expect(await f.controller.destroy(f.workspace().generation)).toBe('ready');
  });

  it('resumes the retained disk after a confirmed idle stop and issues a fresh launch document', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation, snapshot);
    expect(await f.controller.launch(ref, startup, 5000)).toEqual({ startSource: 'repository' });
    expect(f.events).toEqual(['run', 'upload', 'tag']);
    expect(f.ec2.runInstance).toHaveBeenCalledWith(config, f.workspace().generation, snapshot);
    const firstKey = awsEc2LaunchKey(f.workspace());
    const firstLaunch = JSON.parse(f.documents.get(firstKey) ?? 'null');
    expect(firstLaunch.env.PROVIDER_INSTANCE_ID).toBe(ref);
    expect(firstLaunch.env).not.toHaveProperty('AWS_EGRESS_IDENTITY');
    expect(f.workspace().allocation.egress?.identityHash).not.toBe(
      firstLaunch.host.identity.secret
    );
    expect(f.workspace().allocation).not.toHaveProperty('env');
    await f.controller.validateAdmission(ref);
    await f.controller.confirmAdmission(ref);
    expect(f.documents.has(firstKey)).toBe(false);
    expect(await f.controller.stop(firstAllocation)).toBe('pending');
    await expect(f.controller.reserve(nextAllocation)).rejects.toMatchObject({ code: 'stopping' });
    f.state('stopped');
    expect(await f.controller.stop(firstAllocation)).toBe('ready');
    const controller = f.restartController();
    expect(await controller.hasRetainedWorkspace()).toBe(true);
    const wakeRef = await controller.reserve(nextAllocation);
    await controller.launch(wakeRef, startup, 5000);
    expect(f.events).toEqual(['run', 'upload', 'tag', 'upload', 'tag', 'start']);
    expect(f.workspace().instanceId).toBe(instanceId);
    expect(awsEc2LaunchKey(f.workspace())).not.toBe(firstKey);
    expect(await controller.stop(firstAllocation)).toBe('ready');
    expect(f.ec2.stop).toHaveBeenCalledTimes(1);
  });

  it('deletes a failed first boot instead of resuming a disk the wrapper never admitted', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation);
    await f.controller.launch(ref, startup, 5000);
    expect(await f.controller.retireAllocation(firstAllocation)).toBe('pending');
    expect(f.ec2.terminate).toHaveBeenCalledExactlyOnceWith(instanceId);
    expect(f.ec2.stop).not.toHaveBeenCalled();
    f.state('terminated');
    f.deleteTestVolumes();
    expect(await f.controller.retireAllocation(firstAllocation)).toBe('ready');
    expect(await f.controller.hasRetainedWorkspace()).toBe(false);
  });

  it('waits for a second observation before treating a retained disk as lost', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation);
    await f.controller.launch(ref, startup, 5000);
    await f.controller.confirmAdmission(ref);
    f.state('stopped');
    await f.controller.retireAllocation(firstAllocation);
    f.ec2.describeVolume.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(f.controller.hasRetainedWorkspace()).rejects.toMatchObject({ code: 'stopping' });
    expect(f.ec2.terminate).not.toHaveBeenCalled();
    expect(await f.controller.hasRetainedWorkspace()).toBe(true);
    expect(f.workspace().dataMissingSince).toBeUndefined();
  });

  it('recovers a committed S3 write after the controller loses the response', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation);
    f.objects.putLaunch.mockImplementationOnce(async (key, body) => {
      f.documents.set(key, body);
      throw new Error('Synthetic transport error');
    });
    await expect(f.controller.launch(ref, startup, 5000)).rejects.toThrow('Synthetic transport');
    expect(f.workspace().allocation.document).toBe('pending');
    expect(f.ec2.setAllocation).not.toHaveBeenCalled();
    expect(await f.restartController().reconcileLaunch(ref)).toEqual({ startSource: 'image' });
    expect(f.objects.putLaunch).toHaveBeenCalledTimes(1);
    expect(f.ec2.runInstance).toHaveBeenCalledTimes(1);
  });

  it('keeps the destruction fence until the instance and its disks are gone', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation);
    await f.controller.launch(ref, startup, 5000);
    const generation = f.workspace().generation;
    expect(await f.controller.destroy(generation)).toBe('pending');
    f.state('terminated');
    expect(await f.controller.destroy(generation)).toBe('pending');
    await expect(f.controller.reserve(nextAllocation)).rejects.toMatchObject({ code: 'stopping' });
    f.deleteTestVolumes();
    expect(await f.controller.destroy(generation)).toBe('ready');
    await f.controller.reserve(nextAllocation);
    expect(f.workspace().generation).not.toBe(generation);
    expect(await f.controller.destroy(generation)).toBe('ready');
    expect(f.ec2.terminate).toHaveBeenCalledTimes(1);
  });

  it('deletes only detached volumes tagged for the generation being destroyed', async () => {
    const f = fixture();
    const ref = await f.controller.reserve(firstAllocation);
    await f.controller.launch(ref, startup, 5000);
    f.state('terminated');
    const generation = f.workspace().generation;
    const volume = await f.ec2.describeVolume(data.id);
    if (!volume) throw new Error('Test volume missing');
    f.ec2.generationVolumes.mockResolvedValueOnce([
      { ...volume, state: 'available', attachments: [] },
    ]);
    expect(await f.controller.destroy(generation)).toBe('pending');
    expect(f.ec2.deleteVolume).toHaveBeenCalledExactlyOnceWith(data.id);
    f.deleteTestVolumes();
    expect(await f.controller.destroy(generation)).toBe('ready');
  });

  it('keeps the grant private when a volume fails validation', async () => {
    const f = fixture();
    f.makeUnencrypted();
    const ref = await f.controller.reserve(firstAllocation);
    await expect(f.controller.launch(ref, startup, 5000)).rejects.toMatchObject({
      code: 'invalid_configuration',
    });
    expect(f.objects.putLaunch).not.toHaveBeenCalled();
    expect(f.ec2.setAllocation).not.toHaveBeenCalled();
  });
});

describe('EC2 stopped-volume snapshots', () => {
  const generation = '76bf1701-e687-499f-9794-f8ee092ce438';
  const captureId = '66cbfa79-4c6e-48b9-bd61-58b132a345c8';
  const source = { config, generation, volumeId: data.id, baseImage: 'synthetic-base' };

  function captureFixture() {
    const operations = new Map<string, AwsEc2SnapshotOperation>();
    const observed: AwsEc2Snapshot = {
      id: snapshot,
      volumeId: data.id,
      accountId: '123456789012',
      state: 'pending',
      encrypted: true,
      tags: new Map([
        [AWS_EC2_TAGS.installation, config.installation],
        [AWS_EC2_TAGS.generation, generation],
        [AWS_EC2_TAGS.capture, captureId],
      ]),
    };
    const ec2 = {
      createSnapshot: vi.fn(async () => observed),
      findSnapshot: vi.fn(async () => observed),
      deleteSnapshot: vi.fn(async () => {}),
    };
    const controller = () =>
      createAwsEc2SnapshotCapture({
        storage: {
          get: async id => operations.get(id),
          update: async (id, update) => {
            operations.set(id, update(operations.get(id)));
          },
          delete: async id => {
            operations.delete(id);
          },
        },
        client: async () => ec2,
        now: () => 1000,
      });
    return { controller, ec2, observed, operations };
  }

  it('recovers by capture tag after a lost response and publishes only an encrypted, completed snapshot', async () => {
    const f = captureFixture();
    f.ec2.createSnapshot.mockRejectedValueOnce(new AwsRequestError(0, 'TransportError'));
    expect(await f.controller().start(captureId, source)).toBe('uncertain');
    expect(f.operations.get(captureId)?.snapshotId).toBeUndefined();
    expect(await f.controller().start(captureId, source)).toBe('accepted');
    expect(f.ec2.createSnapshot).toHaveBeenCalledTimes(1);
    expect(f.ec2.findSnapshot).toHaveBeenCalledWith(config, { captureId });
    expect(await f.controller().poll(captureId)).toEqual({ status: 'in_progress' });
    f.observed.state = 'completed';
    expect(await f.controller().poll(captureId)).toMatchObject({
      status: 'stored',
      snapshotId: snapshot,
    });
  });

  it('verifies the captured volume generation before removing a superseded snapshot', async () => {
    const f = captureFixture();
    expect(await f.controller().start(captureId, source)).toBe('accepted');
    expect(await f.controller().discard(captureId)).toBe('pending');
    expect(f.ec2.deleteSnapshot).not.toHaveBeenCalled();
    f.observed.state = 'completed';
    f.observed.tags.delete(AWS_EC2_TAGS.generation);
    await expect(f.controller().discard(captureId)).rejects.toMatchObject({
      code: 'Ec2SnapshotIdentityMismatch',
    });
    expect(f.ec2.deleteSnapshot).not.toHaveBeenCalled();
  });
});
