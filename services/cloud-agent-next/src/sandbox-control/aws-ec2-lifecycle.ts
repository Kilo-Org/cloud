import { z } from 'zod';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import {
  AWS_EC2_DATA_DEVICE,
  AWS_EC2_TAGS,
  awsEc2ByocConfigurationSchema,
  awsEc2InstanceIdSchema,
  awsEc2SnapshotIdSchema,
  awsEc2VolumeIdSchema,
  type AwsEc2ByocConfiguration,
} from '@kilocode/worker-utils/aws-ec2';
import {
  assertAwsEc2Instance,
  assertAwsEc2Ownership,
  type AwsEc2Client,
  type AwsEc2Instance,
} from '@kilocode/worker-utils/aws-ec2-client';
import { awsEc2HostLaunchSchema, type AwsEc2HostLaunch } from '@kilocode/worker-utils/aws-egress';
import type { AwsEc2ObjectStore } from '../agent-sandbox/aws/object-store.js';
import { renderAwsLaunchDocument } from './aws-launch-document.js';
import { hashSandboxCredential } from './credential.js';
import {
  ProviderCreationError,
  ProviderStoppedError,
  type ProviderLaunchResult,
  type ProviderObservation,
  type ProviderStartup,
} from './provider.js';

// Bound retries to the interval in which we can rely on the EC2 client token.
const AWS_LAUNCH_RECOVERY_MS = 5 * 60_000;
const AWS_ABSENCE_SETTLE_MS = 60_000;

const allocationSchema = z.object({
  id: z.uuid(),
  startedAt: z.number().int().nonnegative(),
  deadlineAt: z.number().int().positive().optional(),
  document: z.enum(['pending', 'ready', 'revoked']).optional(),
  resumeSubmittedAt: z.number().int().nonnegative().optional(),
  cleanStop: z.boolean().optional(),
  egress: z
    .object({
      identityHash: z.string().regex(/^[a-f0-9]{64}$/),
      expiresAt: z.number().int().positive(),
    })
    .optional(),
});

export const awsEc2WorkspaceSchema = z.object({
  sandboxId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  config: awsEc2ByocConfigurationSchema,
  generation: z.uuid(),
  createdForAllocation: z.uuid(),
  phase: z.enum(['reserved', 'starting', 'active', 'stopping', 'retained', 'destroying']),
  allocation: allocationSchema,
  restoreSnapshotId: awsEc2SnapshotIdSchema.optional(),
  instanceId: awsEc2InstanceIdSchema.optional(),
  volumes: z.object({ root: awsEc2VolumeIdSchema, data: awsEc2VolumeIdSchema }).optional(),
  dataMissingSince: z.number().int().nonnegative().optional(),
  admitted: z.literal(true).optional(),
  submittedAt: z.number().int().nonnegative().optional(),
});
export type AwsEc2Workspace = z.infer<typeof awsEc2WorkspaceSchema>;

export type AwsEc2WorkspaceStorage = {
  get(): Promise<unknown>;
  put(record: AwsEc2Workspace): Promise<void>;
  delete(): Promise<void>;
};

type LifecycleEc2Client = Pick<
  AwsEc2Client,
  | 'describeInstance'
  | 'describeVolume'
  | 'deleteVolume'
  | 'findGeneration'
  | 'generationVolumes'
  | 'runInstance'
  | 'setAllocation'
  | 'start'
  | 'stop'
  | 'terminate'
>;
type Runtime = { ec2: LifecycleEc2Client; objects: AwsEc2ObjectStore };
type Readiness = 'ready' | 'pending';

export function awsEc2Ref(workspace: AwsEc2Workspace): string {
  return `aws-ec2/${workspace.sandboxId}/${workspace.generation}/${workspace.allocation.id}`;
}

export function awsEc2LaunchKey(workspace: AwsEc2Workspace): string {
  return hostObjectKey(workspace, 'launch');
}

function hostObjectKey(workspace: AwsEc2Workspace, kind: 'launch' | 'stopped'): string {
  const { config, instanceId } = workspace;
  if (!instanceId) throw new ProviderCreationError('invalid_configuration');
  const arn = `arn:aws:ec2:${config.region}:${config.roleArn.split(':')[4]}:instance/${instanceId}`;
  return `kilo/${kind}/${arn}/${workspace.allocation.id}.json`;
}

/** A single sandbox DO owns this controller. Serialize all AWS mutations for its workspace. */
export function createAwsEc2Lifecycle(deps: {
  sandboxId: string;
  storage: AwsEc2WorkspaceStorage;
  configuration(): Promise<AwsEc2ByocConfiguration>;
  runtime(config: AwsEc2ByocConfiguration): Promise<Runtime>;
  prepareHost: (workspace: AwsEc2Workspace) => Promise<AwsEc2HostLaunch>;
  assertLaunchActive?(): void;
  serialize?<T>(run: () => Promise<T>): Promise<T>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let pending = Promise.resolve();
  function serialized<T>(run: () => Promise<T>): Promise<T> {
    if (deps.serialize) return deps.serialize(run);
    const result = pending.then(run);
    pending = result.then(
      () => {},
      () => {}
    );
    return result;
  }
  async function read() {
    return awsEc2WorkspaceSchema.optional().parse(await deps.storage.get());
  }
  async function write(workspace: AwsEc2Workspace) {
    await deps.storage.put(workspace);
    return workspace;
  }
  async function forRef(ref: string) {
    const current = await read();
    if (!current || awsEc2Ref(current) !== ref) throw new ProviderStoppedError();
    return current;
  }
  async function findVm(workspace: AwsEc2Workspace, ec2: LifecycleEc2Client) {
    const vm = workspace.instanceId
      ? await ec2.describeInstance(workspace.instanceId)
      : await ec2.findGeneration(workspace.config, workspace.generation);
    if (vm) assertAwsEc2Ownership(vm, workspace.config, workspace.generation);
    return vm;
  }
  async function checkedVolumes(
    workspace: AwsEc2Workspace,
    vm: AwsEc2Instance,
    ec2: LifecycleEc2Client
  ) {
    const root = vm.volumes.find(volume => volume.device === vm.rootDevice);
    const data = vm.volumes.find(volume => volume.device === AWS_EC2_DATA_DEVICE);
    if (!root || !data) return undefined;
    if (
      vm.volumes.length !== 2 ||
      root.id === data.id ||
      (workspace.volumes &&
        (root.id !== workspace.volumes.root || data.id !== workspace.volumes.data))
    )
      throw new ProviderCreationError('invalid_configuration');
    for (const mapping of [root, data]) {
      const volume = await ec2.describeVolume(mapping.id);
      if (!volume) return undefined;
      const attached = volume.attachments[0];
      if (
        !mapping.deleteOnTermination ||
        !volume.encrypted ||
        volume.tags.get(AWS_EC2_TAGS.generation) !== workspace.generation ||
        volume.tags.get(AWS_EC2_TAGS.installation) !== workspace.config.installation ||
        volume.attachments.length !== 1 ||
        attached.instanceId !== vm.id ||
        attached.device !== mapping.device ||
        !attached.deleteOnTermination
      )
        throw new ProviderCreationError('invalid_configuration');
      if (volume.state !== 'in-use' || attached.state !== 'attached') return undefined;
    }
    return { root: root.id, data: data.id };
  }
  async function revoke(workspace: AwsEc2Workspace, objects: AwsEc2ObjectStore) {
    if (workspace.allocation.document === undefined || workspace.allocation.document === 'revoked')
      return workspace;
    await objects.deleteLaunch(awsEc2LaunchKey(workspace));
    return write({ ...workspace, allocation: { ...workspace.allocation, document: 'revoked' } });
  }
  function launchResult(workspace: AwsEc2Workspace): ProviderLaunchResult {
    return { startSource: workspace.restoreSnapshotId ? 'repository' : 'image' };
  }
  async function advanceLaunch(
    workspace: AwsEc2Workspace,
    startup?: { value: ProviderStartup; deadlineAt: number }
  ): Promise<ProviderLaunchResult | undefined> {
    if (workspace.phase === 'active') return launchResult(workspace);
    if (workspace.phase !== 'reserved' && workspace.phase !== 'starting')
      throw new ProviderStoppedError();
    const deadlineAt = workspace.allocation.deadlineAt ?? startup?.deadlineAt;
    if (deadlineAt === undefined || deadlineAt <= now()) return undefined;
    if (workspace.phase === 'reserved') {
      workspace = await write({
        ...workspace,
        phase: 'starting',
        allocation: { ...workspace.allocation, deadlineAt },
      });
    }
    const { ec2, objects } = await deps.runtime(workspace.config);
    let vm = await findVm(workspace, ec2);
    if (!vm) {
      if (workspace.instanceId || !startup) return undefined;
      if (
        workspace.submittedAt !== undefined &&
        now() - workspace.submittedAt >= AWS_LAUNCH_RECOVERY_MS
      )
        throw new ProviderCreationError('cleanup_required');
      deps.assertLaunchActive?.();
      if (workspace.submittedAt === undefined)
        workspace = await write({ ...workspace, submittedAt: now() });
      vm = await ec2.runInstance(
        workspace.config,
        workspace.generation,
        workspace.restoreSnapshotId
      );
    }
    if (workspace.instanceId === undefined)
      workspace = await write({ ...workspace, instanceId: vm.id });
    if (vm.state === 'terminated' || vm.state === 'shutting-down') throw new ProviderStoppedError();
    if (vm.state !== 'running' && vm.state !== 'stopped') return undefined;
    assertAwsEc2Instance(vm, workspace.config, workspace.generation);
    const volumes = await checkedVolumes(workspace, vm, ec2);
    if (!volumes || deadlineAt <= now()) return undefined;
    if (!workspace.volumes) workspace = await write({ ...workspace, volumes });
    const key = awsEc2LaunchKey(workspace);
    if (workspace.allocation.document === undefined) {
      if (!startup) return undefined;
      workspace = await write({
        ...workspace,
        allocation: { ...workspace.allocation, document: 'pending' },
      });
    }
    if (workspace.allocation.document === 'pending') {
      if (!(await objects.launchExists(key))) {
        if (!startup || deadlineAt <= now()) return undefined;
        const host = awsEc2HostLaunchSchema.parse(await deps.prepareHost(workspace));
        if (
          host.instanceId !== vm.id ||
          host.dataVolumeId !== volumes.data ||
          host.sandboxId !== deps.sandboxId ||
          host.allocationId !== workspace.allocation.id ||
          host.expiresAt <= deadlineAt ||
          host.identity.generation !== workspace.generation ||
          host.identity.stackId !== workspace.config.stackId
        )
          throw new ProviderCreationError('invalid_configuration');
        workspace = await write({
          ...workspace,
          allocation: {
            ...workspace.allocation,
            egress: {
              identityHash: await hashSandboxCredential(host.identity.secret),
              expiresAt: host.expiresAt,
            },
          },
        });
        await objects.putLaunch(
          key,
          renderAwsLaunchDocument({
            startup: startup.value,
            providerRef: awsEc2Ref(workspace),
            deadlineAt,
            host,
          })
        );
      }
      if (!workspace.allocation.egress) throw new ProviderCreationError('invalid_configuration');
      workspace = await write({
        ...workspace,
        allocation: { ...workspace.allocation, document: 'ready' },
      });
    }
    if (deadlineAt <= now()) return undefined;
    deps.assertLaunchActive?.();
    await ec2.setAllocation(vm.id, workspace.allocation.id);
    if (deadlineAt <= now()) return undefined;
    if (vm.state === 'stopped') {
      deps.assertLaunchActive?.();
      workspace = await write({
        ...workspace,
        allocation: { ...workspace.allocation, resumeSubmittedAt: now() },
      });
      await ec2.start(vm.id);
    }
    await write({ ...workspace, phase: 'active' });
    return launchResult(workspace);
  }

  async function stop(workspace: AwsEc2Workspace): Promise<Readiness> {
    if (workspace.phase === 'retained') return 'ready';
    if (workspace.phase === 'destroying') return destroy(workspace);
    workspace = await write({ ...workspace, phase: 'stopping' });
    if (!workspace.instanceId && workspace.submittedAt === undefined) {
      await deps.storage.delete();
      return 'ready';
    }
    const { ec2, objects } = await deps.runtime(workspace.config);
    const vm = await findVm(workspace, ec2);
    if (!vm) {
      if (
        !workspace.instanceId &&
        workspace.submittedAt !== undefined &&
        now() - workspace.submittedAt >= AWS_LAUNCH_RECOVERY_MS + AWS_ABSENCE_SETTLE_MS
      )
        return destroy(workspace);
      return 'pending';
    }
    if (!workspace.instanceId) workspace = await write({ ...workspace, instanceId: vm.id });
    if (vm.state === 'running') {
      if (workspace.allocation.resumeSubmittedAt !== undefined) {
        workspace = await write({
          ...workspace,
          allocation: { ...workspace.allocation, resumeSubmittedAt: undefined },
        });
      }
      await ec2.stop(vm.id);
    }
    if (vm.state === 'terminated') return destroy(workspace);
    if (vm.state !== 'stopped') return 'pending';
    if (
      workspace.allocation.resumeSubmittedAt !== undefined &&
      now() - workspace.allocation.resumeSubmittedAt < AWS_LAUNCH_RECOVERY_MS
    )
      return 'pending';
    workspace = await revoke(workspace, objects);
    await write({
      ...workspace,
      phase: 'retained',
      allocation: {
        ...workspace.allocation,
        cleanStop: await objects.cleanStopExists(hostObjectKey(workspace, 'stopped')),
      },
    });
    return 'ready';
  }

  async function destroy(workspace: AwsEc2Workspace): Promise<Readiness> {
    workspace = await write({ ...workspace, phase: 'destroying' });
    if (!workspace.instanceId && workspace.submittedAt === undefined) {
      await deps.storage.delete();
      return 'ready';
    }
    const { ec2, objects } = await deps.runtime(workspace.config);
    const vm = await findVm(workspace, ec2);
    if (vm) {
      if (!workspace.instanceId) workspace = await write({ ...workspace, instanceId: vm.id });
      if (vm.state !== 'terminated') {
        if (vm.state !== 'shutting-down') await ec2.terminate(vm.id);
        return 'pending';
      }
    } else if (
      workspace.submittedAt === undefined ||
      now() - workspace.submittedAt < AWS_LAUNCH_RECOVERY_MS + AWS_ABSENCE_SETTLE_MS
    ) {
      return 'pending';
    }
    await revoke(workspace, objects);
    if (workspace.instanceId) await objects.deleteCleanStop(hostObjectKey(workspace, 'stopped'));
    const volumes = await ec2.generationVolumes(workspace.config, workspace.generation);
    if (volumes.length) {
      for (const volume of volumes) {
        if (
          volume.tags.get(AWS_EC2_TAGS.installation) !== workspace.config.installation ||
          volume.tags.get(AWS_EC2_TAGS.generation) !== workspace.generation
        )
          throw new ProviderCreationError('invalid_configuration');
        if (volume.state === 'available' && volume.attachments.length === 0)
          await ec2.deleteVolume(volume.id);
      }
      return 'pending';
    }
    if (workspace.volumes) {
      for (const id of [workspace.volumes.root, workspace.volumes.data])
        if (await ec2.describeVolume(id)) return 'pending';
    }
    await deps.storage.delete();
    return 'ready';
  }

  return {
    read,
    captureStopped<T>(ref: string, capture: (workspace: AwsEc2Workspace) => Promise<T>) {
      return serialized(async () => {
        const workspace = await read();
        if (
          !workspace ||
          awsEc2Ref(workspace) !== ref ||
          workspace.phase !== 'retained' ||
          !workspace.allocation.cleanStop
        )
          return undefined;
        const { ec2 } = await deps.runtime(workspace.config);
        const vm = await findVm(workspace, ec2);
        if (
          vm?.state !== 'stopped' ||
          !workspace.volumes ||
          !(await checkedVolumes(workspace, vm, ec2))
        )
          return undefined;
        assertAwsEc2Instance(vm, workspace.config, workspace.generation);
        return capture(workspace);
      });
    },
    hasRetainedWorkspace() {
      return serialized(async () => {
        const workspace = await read();
        if (!workspace) return false;
        if (workspace.phase === 'destroying') {
          if ((await destroy(workspace)) === 'ready') return false;
          throw new ProviderCreationError('stopping');
        }
        if (workspace.phase !== 'retained') throw new ProviderCreationError('stopping');
        const { ec2 } = await deps.runtime(workspace.config);
        const vm = await findVm(workspace, ec2);
        if (vm?.state === 'terminated' || !vm) {
          if ((await destroy(workspace)) === 'ready') return false;
          throw new ProviderCreationError('stopping');
        }
        if (vm.state !== 'stopped') throw new ProviderCreationError('stopping');
        assertAwsEc2Instance(vm, workspace.config, workspace.generation);
        if (!(await checkedVolumes(workspace, vm, ec2))) {
          if (workspace.volumes && !(await ec2.describeVolume(workspace.volumes.data))) {
            if (workspace.dataMissingSince === undefined) {
              await write({ ...workspace, dataMissingSince: now() });
            } else if (now() - workspace.dataMissingSince >= AWS_ABSENCE_SETTLE_MS) {
              if ((await destroy(workspace)) === 'ready') return false;
            }
          } else if (workspace.dataMissingSince !== undefined) {
            await write({ ...workspace, dataMissingSince: undefined });
          }
          throw new ProviderCreationError('stopping');
        }
        if (workspace.dataMissingSince !== undefined)
          await write({ ...workspace, dataMissingSince: undefined });
        return true;
      });
    },
    async reserve(
      allocationId: string,
      restoreSnapshotId?: string,
      configuration?: AwsEc2ByocConfiguration
    ) {
      return serialized(async () => {
        const current = await read();
        if (
          current?.allocation.id === allocationId &&
          (current.phase === 'starting' || current.phase === 'reserved')
        )
          return awsEc2Ref(current);
        if (current && current.phase !== 'retained') throw new ProviderCreationError('stopping');
        const config = configuration ?? (await deps.configuration());
        if (current && JSON.stringify(config) !== JSON.stringify(current.config))
          throw new ProviderCreationError('invalid_configuration');
        const allocation = { id: z.uuid().parse(allocationId), startedAt: now() };
        const workspace = current
          ? { ...current, phase: 'reserved' as const, allocation, restoreSnapshotId: undefined }
          : {
              config,
              sandboxId: deps.sandboxId,
              createdForAllocation: allocation.id,
              generation: crypto.randomUUID(),
              phase: 'reserved' as const,
              allocation,
              restoreSnapshotId: awsEc2SnapshotIdSchema.optional().parse(restoreSnapshotId),
            };
        return awsEc2Ref(await write(workspace));
      });
    },
    async launch(ref: string, value: ProviderStartup, deadlineAt: number) {
      while (now() < deadlineAt) {
        const result = await serialized(async () =>
          advanceLaunch(await forRef(ref), { value, deadlineAt })
        );
        if (result) return result;
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(1000, Math.max(0, deadlineAt - now())))
        );
      }
      throw new AwsRequestError(0, 'Ec2StartupTimedOut');
    },
    reconcileLaunch(ref: string) {
      return serialized(async () => advanceLaunch(await forRef(ref)));
    },
    async observe(ref: string | null, allocationId?: string): Promise<ProviderObservation> {
      const workspace = await read();
      if (
        !workspace ||
        (ref ? awsEc2Ref(workspace) !== ref : workspace.allocation.id !== allocationId)
      )
        return { status: 'terminal' };
      const providerRef = awsEc2Ref(workspace);
      if (workspace.phase === 'retained') return { status: 'terminal', providerRef };
      if (workspace.phase !== 'active') return { status: 'unknown', providerRef };
      const vm = await findVm(workspace, (await deps.runtime(workspace.config)).ec2);
      if (
        vm?.state === 'running' &&
        vm.tags.get(AWS_EC2_TAGS.allocation) === workspace.allocation.id
      )
        return { status: 'active', providerRef };
      if (vm?.state === 'terminated' || vm?.state === 'shutting-down')
        return { status: 'terminal', providerRef };
      return { status: 'unknown', providerRef };
    },
    async validateAdmission(ref: string) {
      const workspace = await forRef(ref);
      if (workspace.phase !== 'active' || !workspace.instanceId) throw new ProviderStoppedError();
      const vm = await findVm(workspace, (await deps.runtime(workspace.config)).ec2);
      if (
        !vm ||
        vm.state !== 'running' ||
        vm.tags.get(AWS_EC2_TAGS.allocation) !== workspace.allocation.id
      )
        throw new ProviderStoppedError();
      assertAwsEc2Instance(vm, workspace.config, workspace.generation);
      const latest = await forRef(ref);
      if (latest.phase !== 'active') throw new ProviderStoppedError();
    },
    confirmAdmission(ref: string) {
      return serialized(async () => {
        let workspace = await forRef(ref);
        if (workspace.phase !== 'active') throw new ProviderStoppedError();
        if (!workspace.admitted) workspace = await write({ ...workspace, admitted: true });
        await revoke(workspace, (await deps.runtime(workspace.config)).objects);
      });
    },
    stop(allocationId: string) {
      return serialized(async () => {
        const workspace = await read();
        return workspace?.allocation.id === allocationId ? stop(workspace) : 'ready';
      });
    },
    retireAllocation(allocationId: string) {
      return serialized(async () => {
        const workspace = await read();
        if (!workspace || workspace.allocation.id !== allocationId) return 'ready';
        return workspace.admitted ? stop(workspace) : destroy(workspace);
      });
    },
    destroy(generation: string) {
      return serialized(async () => {
        const workspace = await read();
        return workspace?.generation === generation ? destroy(workspace) : 'ready';
      });
    },
  };
}
