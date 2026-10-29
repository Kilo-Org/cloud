import type { CloudflareContainersInstance } from '@kilocode/worker-utils/sandbox-allocation';
import { hashToSandboxId } from '../sandbox-id.js';
import type { EnvironmentBuildRunner } from '../shared/environment-build-protocol.js';
import type { SandboxBillingInput } from '../container-usage-context.js';
import { ProviderCreationError } from '../sandbox-control/provider.js';
import { createCloudflareContainersProviderAdapter } from '../sandbox-control/cloudflare-containers-provider.js';
import { encodeCloudflareProviderRef } from '../sandbox-control/cloudflare-provider.js';
import { leaseAtLeastMs } from '../sandbox-control/deadlines.js';
import { downloadedStartup } from '../sandbox-control/downloaded-startup.js';
import { SHA256_PATTERN } from '../sandbox-control/runtime-release.js';
import type { Env } from '../types.js';
import type {
  NativeCaptureResult,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import type { ProviderAdapter } from '../sandbox-control/provider.js';
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

export type BuilderAllocation = NativeBuilderAllocation | VercelBuilderAllocation;

/** Mutable, non-secret Vercel lifecycle state kept outside the immutable build input. */
export type BuilderLifecycleState = {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
  clear(): Promise<void>;
};

export type BuilderLaunch = {
  /** Delivered to the running builder by exec or write, never as image environment. */
  runner: EnvironmentBuildRunner;
  deadlineAt: number;
};

export type BuilderProvider = {
  /** Container billing admission and attribution; throws `ProviderCreationError` when refused. */
  admitBilling(allocation: BuilderAllocation, billing: SandboxBillingInput): Promise<void>;
  /** Start or confirm the builder with the deployment startup selection. */
  launch(
    allocation: BuilderAllocation,
    launch: BuilderLaunch,
    state: BuilderLifecycleState
  ): Promise<void>;
  capture(
    allocation: BuilderAllocation,
    captureId: string,
    state: BuilderLifecycleState
  ): Promise<NativeCaptureResult>;
  stop(
    allocation: BuilderAllocation,
    state: BuilderLifecycleState
  ): Promise<'terminal' | 'retryable'>;
  renewLease(allocation: BuilderAllocation, state: BuilderLifecycleState): Promise<void>;
  /** SHA-256 of the runtime release descriptor, or null when unavailable. */
  runtimeReleaseId(): Promise<string | null>;
  /** The image a native container in `sandboxId` starts from now, or null when unreadable. */
  currentImage(sandboxId: string): Promise<string | null>;
};

export { builderInstance, builderRuntimeUnsupportedReason };
export { BuilderRetryableError };

/** The one builder container DO name for an environment. */
export function builderSandboxId(environmentId: string): Promise<string> {
  return hashToSandboxId(`environment-build:v1:${environmentId}`, 'sbx');
}

/** A deterministic, provider-valid builder sandbox name for one build. */
export function vercelBuilderSandboxName(buildId: string): string {
  return `ses-envbuild-${buildId.replaceAll('-', '').slice(0, 40)}`;
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
}): BuilderProvider {
  const adapterFor = (allocation: NativeBuilderAllocation): ProviderAdapter =>
    createCloudflareContainersProviderAdapter({
      logicalSandboxId: allocation.sandboxId,
      allocationName: allocation.sandboxId,
      instance: allocation.instance,
      getContainer: id => deps.containers.getByName(id),
    });
  const stub = (allocation: NativeBuilderAllocation) =>
    deps.containers.getByName(allocation.sandboxId);

  return {
    async admitBilling(allocation, billing) {
      if (allocation.provider === 'vercel') return;
      await adapterFor(allocation).ensureBillingAdmission(providerRef(allocation), billing);
    },
    async launch(allocation, launch, state) {
      if (allocation.provider === 'vercel') {
        const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
        if (!descriptor) throw new ProviderCreationError('invalid_configuration');
        const opened = await openVercelBuilder(deps.env, allocation, deps.fetch);
        const command = await downloadedStartup({
          env: deps.env,
          descriptor,
          sandboxId: allocation.sandboxId,
          allocationId: allocation.allocationId,
          deadlineAt: launch.deadlineAt,
          mainProcess: 'environment-builder',
        });
        await launchVercelBuilder({
          allocation,
          launch,
          state,
          client: opened.client,
          command,
          runtime: opened.runtime,
          initialTimeoutMs: opened.initialTimeoutMs,
          now: deps.now,
        });
        return;
      }
      const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
      if (builderRuntimeUnsupportedReason(deps.env) !== null || !descriptor) {
        throw new ProviderCreationError('invalid_configuration');
      }
      const command = await downloadedStartup({
        env: deps.env,
        descriptor,
        sandboxId: allocation.sandboxId,
        allocationId: allocation.allocationId,
        deadlineAt: launch.deadlineAt,
        mainProcess: 'environment-builder',
      });
      const ref = providerRef(allocation);
      await stub(allocation).launchBuilder({
        allocationRef: ref,
        runner: launch.runner,
        instance: allocation.instance,
        deadlineAt: launch.deadlineAt,
        command,
      });
      await stub(allocation).ensureLeaseAtLeast(ref, leaseAtLeastMs());
    },
    async capture(allocation, captureId, state) {
      if (allocation.provider === 'vercel') {
        let opened;
        try {
          opened = await openVercelBuilder(deps.env, allocation, deps.fetch);
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
      }
      return stub(allocation).captureSnapshot(providerRef(allocation), captureId);
    },
    async stop(allocation, state) {
      if (allocation.provider === 'vercel') {
        try {
          const opened = await openVercelBuilder(deps.env, allocation, deps.fetch);
          return await stopVercelBuilder({
            allocation,
            state,
            client: opened.client,
            runtime: opened.runtime,
            now: deps.now,
          });
        } catch (error) {
          if (error instanceof BuilderRetryableError) return 'retryable';
          throw error;
        }
      }
      return adapterFor(allocation).stop(providerRef(allocation));
    },
    async renewLease(allocation) {
      // Native containers need a lease extension. A Vercel builder's initial
      // timeout already covers the build deadline and extending it would only
      // outlive the build.
      if (allocation.provider === 'vercel') return;
      await adapterFor(allocation).ensureLeaseAtLeast(providerRef(allocation), leaseAtLeastMs());
    },
    async runtimeReleaseId() {
      const descriptor = deps.env.RUNTIME_RELEASE_DESCRIPTOR;
      return !descriptor
        ? null
        : SHA256_PATTERN.test(descriptor)
          ? descriptor
          : sha256Hex(descriptor);
    },
    async currentImage(sandboxId) {
      try {
        return await deps.containers.getByName(sandboxId).currentImage('runtime-free');
      } catch {
        return null;
      }
    },
  };
}
