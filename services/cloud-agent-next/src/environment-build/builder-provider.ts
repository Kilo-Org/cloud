import {
  CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
  type CloudflareContainersInstance,
} from '@kilocode/worker-utils/sandbox-allocation';
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

/**
 * Physical builder lifecycle over the native Containers primitives (plan "Use a
 * dedicated builder runner ... Reuse ... provider lifecycle primitives"). The
 * builder container DO is named for its environment, so a builder can never
 * share a container DO with a session. Billing admission, stop and lease reuse
 * the session provider adapter; only the start uses the builder entry point.
 */

export type BuilderAllocation = {
  /** The container DO name and the billing sandbox key (`sbx-` placed key, isolated kind). */
  sandboxId: string;
  allocationId: string;
  instance: CloudflareContainersInstance;
};

export type BuilderLaunch = {
  /** Delivered to the running builder by exec, never as container start env. */
  runner: EnvironmentBuildRunner;
  deadlineAt: number;
};

export type BuilderProvider = {
  /** Container billing admission and attribution; throws `ProviderCreationError` when refused. */
  admitBilling(allocation: BuilderAllocation, billing: SandboxBillingInput): Promise<void>;
  /** Start or confirm the builder with the deployment startup selection. */
  launch(allocation: BuilderAllocation, launch: BuilderLaunch): Promise<void>;
  capture(allocation: BuilderAllocation, captureId: string): Promise<NativeCaptureResult>;
  stop(allocation: BuilderAllocation): Promise<'terminal' | 'retryable'>;
  renewLease(allocation: BuilderAllocation): Promise<void>;
  /** SHA-256 of the runtime release descriptor, or null when unavailable. */
  runtimeReleaseId(): Promise<string | null>;
  /** The image a container in `sandboxId` starts from now, or null when unreadable. */
  currentImage(sandboxId: string): Promise<string | null>;
};

/** The one builder container DO name for an environment. */
export function builderSandboxId(environmentId: string): Promise<string> {
  return hashToSandboxId(`environment-build:v1:${environmentId}`, 'sbx');
}

/** `standard-4` when setup commands exist, otherwise the default native instance. */
export function builderInstance(commands: readonly string[]): CloudflareContainersInstance {
  return commands.length > 0 ? 'standard-4' : CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
}

function providerRef(allocation: BuilderAllocation): string {
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

/** Snapshot enrollment is separate from the interactive session runtime cohort. */
export function builderRuntimeUnsupportedReason(env: BuilderRuntimeEnv): string | null {
  return env.RUNTIME_STARTUP_MODE === 'downloaded' &&
    env.NATIVE_RUNTIME_IMAGE === 'runtime-free' &&
    env.RUNTIME_RELEASE_DESCRIPTOR &&
    env.RUNTIME_RELEASE_BUCKET
    ? null
    : 'Environment snapshots require the downloaded runtime-free image and runtime release';
}

export function createBuilderProvider(deps: {
  containers: DurableObjectNamespace<SandboxContainers>;
  env: BuilderRuntimeEnv;
}): BuilderProvider {
  const adapterFor = (allocation: BuilderAllocation): ProviderAdapter =>
    createCloudflareContainersProviderAdapter({
      logicalSandboxId: allocation.sandboxId,
      allocationName: allocation.sandboxId,
      instance: allocation.instance,
      getContainer: id => deps.containers.getByName(id),
    });
  const stub = (allocation: BuilderAllocation) => deps.containers.getByName(allocation.sandboxId);

  return {
    async admitBilling(allocation, billing) {
      await adapterFor(allocation).ensureBillingAdmission(providerRef(allocation), billing);
    },
    async launch(allocation, launch) {
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
    capture(allocation, captureId) {
      return stub(allocation).captureSnapshot(providerRef(allocation), captureId);
    },
    stop(allocation) {
      return adapterFor(allocation).stop(providerRef(allocation));
    },
    async renewLease(allocation) {
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
