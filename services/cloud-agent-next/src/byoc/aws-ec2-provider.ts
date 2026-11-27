import { z } from 'zod';
import {
  AWS_EC2_INSTANCE_TYPE,
  AWS_EC2_TAGS,
  awsEc2SnapshotIdSchema,
  type AwsEc2ByocConfiguration,
} from '@kilocode/worker-utils/aws-ec2';
import {
  awsEc2Ref,
  createAwsEc2Lifecycle,
  type AwsEc2WorkspaceStorage,
} from '../sandbox-control/aws-ec2-lifecycle.js';
import {
  createAwsEc2SnapshotCapture,
  type AwsEc2SnapshotStorage,
} from '../sandbox-control/aws-ec2-snapshot.js';
import {
  ProviderCreationError,
  ProviderSnapshotCreationError,
  ProviderStoppedError,
  type ProviderAdapter,
} from '../sandbox-control/provider.js';
import type { SnapshotRestoreRequest } from '../sandbox-control/snapshots.js';
import type { Env } from '../types.js';
import { resolveAwsEc2ByocConfiguration } from './aws-credential-resolver.js';
import { createAwsEc2RuntimeAccess, prepareAwsEc2Host } from './aws-ec2-runtime.js';
import type { ByocSource } from './owner.js';

const STARTUP_WINDOW_MS = 10 * 60_000;

export function awsEc2FilesystemBase(connectionId: string, config: AwsEc2ByocConfiguration) {
  return `aws-ec2-ebs:v1:${connectionId}/${config.installation}`;
}

function parseRef(ref: string) {
  const [provider, sandboxId, generation, allocationId, extra] = ref.split('/');
  if (provider !== 'aws-ec2' || extra !== undefined) return undefined;
  return z
    .object({ sandboxId: z.string(), generation: z.uuid(), allocationId: z.uuid() })
    .safeParse({ sandboxId, generation, allocationId }).data;
}

export function createByocAwsEc2ProviderAdapter(input: {
  env: Env;
  source: ByocSource;
  sandboxId: string;
  storage: AwsEc2WorkspaceStorage;
  captures: AwsEc2SnapshotStorage;
}): ProviderAdapter {
  const configuration = () => resolveAwsEc2ByocConfiguration(input.env, input.source);
  const runtime = createAwsEc2RuntimeAccess(input.env);
  const controller = createAwsEc2Lifecycle({
    sandboxId: input.sandboxId,
    storage: input.storage,
    configuration,
    runtime,
    prepareHost: workspace => prepareAwsEc2Host(input.env, input.sandboxId, workspace),
  });
  const captures = createAwsEc2SnapshotCapture({
    storage: input.captures,
    client: async config => (await runtime(config)).ec2,
  });

  async function restoreId(snapshot: SnapshotRestoreRequest, config: AwsEc2ByocConfiguration) {
    if (snapshot.provider !== 'aws-ec2') throw new ProviderSnapshotCreationError('provenance');
    if (snapshot.baseImage !== awsEc2FilesystemBase(input.source.credentialId, config))
      throw new ProviderSnapshotCreationError('image_mismatch');
    const id = awsEc2SnapshotIdSchema.safeParse(snapshot.snapshotId).data;
    if (!id) throw new ProviderSnapshotCreationError('provenance');
    const { ec2 } = await runtime(config);
    const source = await ec2.findSnapshot(config, { id });
    if (!source) throw new ProviderSnapshotCreationError('missing');
    if (source.state === 'pending') throw new ProviderSnapshotCreationError('transient');
    if (
      source.state !== 'completed' ||
      source.encrypted !== true ||
      !z.uuid().safeParse(source.tags.get(AWS_EC2_TAGS.generation)).success ||
      !z.uuid().safeParse(source.tags.get(AWS_EC2_TAGS.capture)).success ||
      (snapshot.kind === 'workspace' &&
        snapshot.captureId !== source.tags.get(AWS_EC2_TAGS.capture))
    )
      throw new ProviderSnapshotCreationError('provenance');
    return id;
  }

  return {
    async create(intent) {
      if (!intent.containment?.kilocode || !intent.containment.github)
        throw new ProviderCreationError('invalid_configuration');
      const config = await configuration();
      await (await runtime(config)).verifyLaunch();
      const snapshotId = intent.snapshot && (await restoreId(intent.snapshot, config));
      return { providerRef: await controller.reserve(intent.intentId, snapshotId, config) };
    },
    async launch(ref, startup, options) {
      return controller.launch(ref, startup, options?.deadlineAt ?? Date.now() + STARTUP_WINDOW_MS);
    },
    reconcileLaunch: ref => controller.reconcileLaunch(ref),
    validateWrapperAdmission: ref => controller.validateAdmission(ref),
    confirmAdmission: ref => controller.confirmAdmission(ref),
    async allocationDeadline(ref) {
      const workspace = await controller.read();
      if (!workspace || awsEc2Ref(workspace) !== ref || !workspace.allocation.egress)
        return undefined;
      return { at: workspace.allocation.egress.expiresAt, reason: 'provider_lifetime_exhausted' };
    },
    describeRuntime(ref) {
      const parsed = parseRef(ref);
      if (!parsed || parsed.sandboxId !== input.sandboxId) return undefined;
      return {
        provider: 'aws-ec2',
        sandboxId: input.sandboxId,
        allocationId: parsed.allocationId,
        instanceType: AWS_EC2_INSTANCE_TYPE,
        region: 'us-east-1',
      };
    },
    observe: (ref, intent) => controller.observe(ref, intent?.intentId),
    async stop(ref, intent) {
      const workspace = await controller.read();
      if (!workspace || (ref && awsEc2Ref(workspace) !== ref)) return 'terminal';
      const id = ref ? workspace.allocation.id : intent?.intentId;
      if (!id) return 'terminal';
      return (await controller.retireAllocation(id)) === 'ready' ? 'terminal' : 'retryable';
    },
    async ensureLeaseAtLeast(ref, ms) {
      const workspace = await controller.read();
      if (!workspace || awsEc2Ref(workspace) !== ref || workspace.phase !== 'active')
        throw new ProviderStoppedError();
      if (!workspace.allocation.egress || Date.now() + ms >= workspace.allocation.egress.expiresAt)
        throw new ProviderStoppedError();
    },
    async ensureBillingAdmission() {},
    async logs() {
      return '';
    },
    retainedWorkspace: {
      available: () => controller.hasRetainedWorkspace(),
      generation: async () => (await controller.read())?.generation,
      destroy: async generation =>
        (await controller.destroy(generation)) === 'ready' ? 'terminal' : 'retryable',
    },
    environmentSnapshots: { provider: 'aws-ec2', phase: 'create' },
    workspaceSnapshots: {
      provider: 'aws-ec2',
      phase: 'create',
      async compatibleBase(capturedBase) {
        const currentBaseImage = awsEc2FilesystemBase(
          input.source.credentialId,
          await configuration()
        );
        return currentBaseImage === capturedBase
          ? { currentBaseImage }
          : { reason: 'image_mismatch' };
      },
      stoppedCapture: {
        async start(ref, captureId) {
          const result = await controller.captureStopped(ref, async workspace => {
            if (!workspace.volumes) return 'unavailable' as const;
            return captures.start(captureId, {
              config: workspace.config,
              generation: workspace.generation,
              volumeId: workspace.volumes.data,
              baseImage: awsEc2FilesystemBase(input.source.credentialId, workspace.config),
            });
          });
          return result ?? 'unavailable';
        },
        poll: id => captures.poll(id),
        discard: id => captures.discard(id),
      },
    },
  };
}
