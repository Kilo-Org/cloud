import {
  resolveBuilderSnapshotBase,
  type BuilderSnapshotBaseInput,
} from './builder-snapshot-base.js';
import type { PublishedSnapshot, SnapshotBase } from './policy.js';
import { builderAllocationSandboxName } from './builder-identity.js';
import type { EnvironmentBuildTarget } from './target.js';
import type { AwsEc2BuilderAllocation } from './aws-ec2-build-target.js';
import { builderSandboxIdForBuild } from './builder-identity.js';
import type { AwsEnvironmentBuildServices } from './aws-build.js';
import { vercelSnapshotBaseImage } from '../byoc/vercel-snapshot-compatibility.js';
export { builderAllocationSandboxName } from './builder-identity.js';
import type { CloudflareContainersInstance } from '@kilocode/worker-utils/sandbox-allocation';
import { hashToSandboxId } from '../sandbox-id.js';
import type { EnvironmentBuildRunner } from '../shared/environment-build-protocol.js';
import type { SandboxBillingInput } from '../container-usage-context.js';
import { ProviderCreationError } from '../sandbox-control/provider.js';
import { createCloudflareContainersProviderAdapter } from '../sandbox-control/cloudflare-containers-provider.js';
import { encodeCloudflareProviderRef } from '../sandbox-control/provider-ref.js';
import { leaseAtLeastMs } from '../sandbox-control/deadlines.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import { SHA256_PATTERN } from '../sandbox-control/runtime-release.js';
import type { Env } from '../types.js';
import type { SandboxContainers } from '../sandbox-containers/SandboxContainers.js';
import type { SnapshotCaptureResult } from '../sandbox-control/snapshots.js';
import type { EnvironmentReference } from '@kilocode/cloud-agent-profile';
import { builderInstance, builderRuntimeUnsupportedReason } from './target.js';
import type { VercelBuildTarget } from './target.js';
import {
  captureVercelBuilder,
  launchVercelBuilder,
  openVercelBuilder,
  stopVercelBuilder,
} from './vercel-builder.js';
import { ByocCredentialMissingError } from '../byoc/vercel-credential-resolver.js';
import {
  BuilderRetryableError,
  BuilderStateInvalidError,
  BuilderTargetMismatchError,
} from './builder-errors.js';

/**
 * Physical builder lifecycle over the native Containers primitives and the
 * Vercel BYOC sandbox API. The builder for an environment is named per build,
 * so two builds can never share a sandbox, and the environment-level native
 * container DO keeps its existing name.
 */

export type NativeBuilderAllocation = {
  provider: 'cloudflare-containers';
  /** The container DO name and the billing sandbox key (`sbx-` placed key, isolated kind). */
  sandboxId: string;
  allocationId: string;
  instance: CloudflareContainersInstance;
};

export type VercelBuilderAllocation = {
  provider: 'vercel';
  /** Deterministic Vercel sandbox name derived from the build id. */
  sandboxId: string;
  allocationId: string;
  owner: EnvironmentReference['owner'];
  target: VercelBuildTarget;
};

export type BuilderAllocation =
  | NativeBuilderAllocation
  | VercelBuilderAllocation
  | AwsEc2BuilderAllocation;

export type { BuilderLifecycleState } from './builder-state.js';
import type { BuilderLifecycleState } from './builder-state.js';

export type BuilderLaunch = {
  networkSecretHosts?: string[];
  /** Delivered to the running builder by exec or write, never as image environment. */
  runner: EnvironmentBuildRunner;
  deadlineAt: number;
};

type BoundBuilderProvider = {
  /** Container billing admission and attribution; throws `ProviderCreationError` when refused. */
  admitBilling(billing: SandboxBillingInput): Promise<void>;
  launch(launch: BuilderLaunch, state: BuilderLifecycleState): Promise<void>;
  capture(captureId: string, state: BuilderLifecycleState): Promise<SnapshotCaptureResult>;
  stop(state: BuilderLifecycleState): Promise<'terminal' | 'retryable'>;
  renewLease(): Promise<void>;
};

export type BuilderProvider = {
  bind(allocation: BuilderAllocation): BoundBuilderProvider;
  /** SHA-256 of the runtime release descriptor, or null when unavailable. */
  runtimeReleaseId(): Promise<string | null>;
  snapshotBase(input: BuilderSnapshotBaseInput): Promise<SnapshotBase>;
  publishedSnapshotBase(target: EnvironmentBuildTarget, capturedBase: string): string;
  snapshotCleanup?: {
    manages(provider: PublishedSnapshot['provider']): boolean;
    release(
      snapshot: PublishedSnapshot,
      allocation: BuilderAllocation,
      state: BuilderLifecycleState
    ): Promise<'done' | 'pending'>;
  };
};

export { builderInstance, builderRuntimeUnsupportedReason };
export { BuilderRetryableError };

/** The one builder container DO name for an environment. */
export function builderSandboxId(environmentId: string): Promise<string> {
  return hashToSandboxId(`environment-build:v1:${environmentId}`, 'sbx');
}

function providerRef(allocation: NativeBuilderAllocation): string {
  return encodeCloudflareProviderRef({
    sandboxId: allocation.sandboxId,
    containment: false,
    instanceId: allocation.allocationId,
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

type BuilderRuntimeEnv = Pick<
  Env,
  | 'RUNTIME_STARTUP_MODE'
  | 'NATIVE_RUNTIME_IMAGE'
  | 'RUNTIME_RELEASE_DESCRIPTOR'
  | 'WORKER_URL'
  | 'NEXTAUTH_SECRET'
  | 'RUNTIME_RELEASE_BUCKET'
>;

type BuilderProviderEnv = BuilderRuntimeEnv & Parameters<typeof openVercelBuilder>[0];

export function createBuilderProvider(deps: {
  containers: DurableObjectNamespace<SandboxContainers>;
  env: BuilderProviderEnv;
  now?: () => number;
  fetch?: typeof fetch;
  aws?: AwsEnvironmentBuildServices;
}): BuilderProvider {
  const skip = async () => {};

  function bind(allocation: BuilderAllocation): BoundBuilderProvider {
    switch (allocation.provider) {
      case 'aws-ec2': {
        const aws = () => {
          if (!deps.aws) throw new ProviderCreationError('invalid_configuration');
          return deps.aws;
        };
        return {
          admitBilling: skip,
          launch: async (launch, state) => aws().launch(allocation, launch, state),
          capture: async (captureId, state) => aws().capture(allocation, captureId, state),
          stop: async state => aws().stop(allocation, state),
          renewLease: skip,
        };
      }
      case 'vercel': {
        const open = () => openVercelBuilder(deps.env, allocation, deps.fetch);
        return {
          admitBilling: skip,
          async launch(launch, state) {
            const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
            if (!descriptor) throw new ProviderCreationError('invalid_configuration');
            const opened = await open();
            await launchVercelBuilder({
              allocation,
              launch,
              state,
              client: opened.client,
              command: await startup(allocation, launch, descriptor),
              runtime: opened.runtime,
              initialTimeoutMs: opened.initialTimeoutMs,
              now: deps.now,
            });
          },
          async capture(captureId, state) {
            let opened;
            try {
              opened = await open();
            } catch (error) {
              if (
                error instanceof ByocCredentialMissingError ||
                error instanceof BuilderTargetMismatchError
              ) {
                return { status: 'failed', reason: 'snapshot_failed' };
              }
              throw error;
            }
            try {
              return await captureVercelBuilder({
                allocation,
                captureId,
                state,
                client: opened.client,
                runtime: opened.runtime,
                now: deps.now,
              });
            } catch (error) {
              if (error instanceof BuilderStateInvalidError) {
                return { status: 'failed', reason: 'snapshot_failed' };
              }
              throw error;
            }
          },
          stop: state => stopVercelBuilder({ allocation, state, open, now: deps.now }),
          // The initial timeout already covers the build deadline.
          renewLease: skip,
        };
      }
      case 'cloudflare-containers': {
        const ref = providerRef(allocation);
        const stub = () => deps.containers.getByName(allocation.sandboxId);
        const adapter = createCloudflareContainersProviderAdapter({
          logicalSandboxId: allocation.sandboxId,
          allocationName: allocation.sandboxId,
          instance: allocation.instance,
          getContainer: id => deps.containers.getByName(id),
        });
        return {
          admitBilling: billing => adapter.ensureBillingAdmission(ref, billing),
          async launch(launch) {
            const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
            if (builderRuntimeUnsupportedReason(deps.env) !== null || !descriptor) {
              throw new ProviderCreationError('invalid_configuration');
            }
            await stub().launchBuilder({
              allocationRef: ref,
              runner: launch.runner,
              instance: allocation.instance,
              deadlineAt: launch.deadlineAt,
              command: await startup(allocation, launch, descriptor),
              ...(launch.networkSecretHosts?.length
                ? { networkSecretHosts: launch.networkSecretHosts }
                : {}),
            });
            await stub().ensureLeaseAtLeast(ref, leaseAtLeastMs());
          },
          capture: captureId => stub().captureSnapshot(ref, captureId),
          stop: () => adapter.stop(ref),
          renewLease: () => adapter.ensureLeaseAtLeast(ref, leaseAtLeastMs()),
        };
      }
    }
  }

  const startup = (allocation: BuilderAllocation, launch: BuilderLaunch, descriptor: string) =>
    downloadedStartup({
      env: deps.env,
      descriptor,
      sandboxId: allocation.sandboxId,
      allocationId: allocation.allocationId,
      deadlineAt: launch.deadlineAt,
      mainProcess: 'environment-builder',
    });

  return {
    bind,
    async runtimeReleaseId() {
      const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
      return !descriptor
        ? null
        : SHA256_PATTERN.test(descriptor)
          ? descriptor
          : sha256Hex(descriptor);
    },
    snapshotBase: input =>
      resolveBuilderSnapshotBase(input, async sandboxId => {
        try {
          return await deps.containers.getByName(sandboxId).currentImage('runtime-free');
        } catch {
          return null;
        }
      }),
    publishedSnapshotBase: (target, capturedBase) =>
      target.provider === 'vercel' ? vercelSnapshotBaseImage(target) : capturedBase,
    ...(deps.aws ? { snapshotCleanup: deps.aws.snapshotCleanup } : {}),
  };
}

/** Project the pinned build target into its physical allocation identity. */
export function builderAllocation(input: {
  target: EnvironmentBuildTarget;
  environmentId: string;
  buildId: string;
  allocationId: string;
  owner: EnvironmentReference['owner'];
  actorUserId: string;
  nativeSandboxId: string;
}): BuilderAllocation {
  const { target, allocationId, owner } = input;
  if (target.provider === 'aws-ec2')
    return {
      provider: target.provider,
      sandboxId: builderSandboxIdForBuild(input.buildId),
      target,
      environmentId: input.environmentId,
      buildId: input.buildId,
      allocationId,
      owner,
      actorUserId: input.actorUserId,
    };
  if (target.provider === 'vercel')
    return {
      provider: 'vercel',
      sandboxId: builderAllocationSandboxName(input.buildId),
      allocationId,
      owner,
      target,
    };
  return {
    provider: 'cloudflare-containers',
    sandboxId: input.nativeSandboxId,
    allocationId,
    instance: target.instance,
  };
}
