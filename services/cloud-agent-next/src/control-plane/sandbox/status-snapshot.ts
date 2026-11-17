/**
 * B10 projection from the V2 allocation state into the public
 * `SandboxStatusSnapshot` (spec "Sandbox Status"). It reads the V2
 * `AllocationView`, never the legacy allocation/health aggregate, so the old
 * model cannot leak back in through this path.
 *
 * This is a passive snapshot: `observedAt` is creation time, not a fresh probe.
 */
import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import { CODE_REVIEW_CONTAINERS_INSTANCE } from '../../sandbox-containers/instance-size.js';
import {
  getSandboxProviderLabel,
  type SandboxRuntimeMetadata,
  type SandboxStatusSnapshot,
} from '../../shared/sandbox-status.js';
import type { AllocationView } from './allocation.js';
import type { RuntimeIdentity } from './runtime-identity.js';

export type AllocationStatusSnapshotInput = {
  /** The V2 allocation view, or null when the sandbox has no owner. */
  allocation: AllocationView | null;
  /** Snapshot creation time; the value of `observedAt`. */
  observedAt: number;
  /**
   * The connected sandbox's heartbeat-confirmed idle stop, independent of the
   * allocation recovery and provider lease backstops.
   */
  inactivityTimeoutMs: number;
  runtimeIdentity?: RuntimeIdentity | null;
};

function containersSandboxType(instance: string): SandboxRuntimeMetadata['sandboxType'] {
  if (instance === 'standard-3') return 'containers-standard-3';
  if (instance === 'standard-4') return 'containers-standard-4';
  if (instance === CODE_REVIEW_CONTAINERS_INSTANCE) return 'code-review';
  return null;
}

function observedRuntime(
  allocation: AllocationView,
  runtimeIdentity: RuntimeIdentity | null | undefined
): SandboxRuntimeMetadata {
  const matched =
    runtimeIdentity?.allocationId === allocation.allocationId ? runtimeIdentity : undefined;
  const configuration = allocation.configuration;
  const instance =
    configuration?.provider === 'cloudflare-containers'
      ? (configuration.instance ?? CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE)
      : CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
  return {
    sandboxType:
      allocation.provider === 'cloudflare-containers' ? containersSandboxType(instance) : 'unknown',
    kiloCliVersion: matched?.kiloCliVersion ?? null,
    wrapperVersion: matched?.wrapperVersion ?? null,
    startedAt: null,
    stoppedAt: null,
  };
}

export function projectAllocationStatusSnapshot(
  input: AllocationStatusSnapshotInput
): SandboxStatusSnapshot {
  const { allocation, observedAt, inactivityTimeoutMs, runtimeIdentity } = input;
  const base = {
    provider: getSandboxProviderLabel(allocation?.provider),
    observedAt,
    inactivityTimeoutMs,
    estimatedSleepAt: null,
    ...(allocation?.provider === 'cloudflare-containers' || allocation?.provider === 'vercel'
      ? { runtime: observedRuntime(allocation, runtimeIdentity) }
      : {}),
  };
  if (allocation === null) {
    return { ...base, status: 'unknown', detailCode: 'insufficient_evidence' };
  }
  switch (allocation.kind) {
    case 'stopped':
      if (allocation.unconfirmedProviderRef !== null) {
        return { ...base, status: 'unknown', detailCode: 'insufficient_evidence' };
      }
      return { ...base, status: 'sleeping', detailCode: 'sandbox_stopped' };
    case 'creating':
    case 'starting':
      return { ...base, status: 'starting', detailCode: 'sandbox_starting' };
    case 'stopping':
      return { ...base, status: 'stopping', detailCode: 'sandbox_stopping' };
    case 'disconnected':
      return { ...base, status: 'unreachable', detailCode: 'connection_unavailable' };
    case 'connected': {
      // The V2 idle anchor is the last wrapper-informed activity; the sleep
      // estimate is honest only when it is still in the future.
      const sleepAt =
        allocation.lastActivityAt === null ? null : allocation.lastActivityAt + inactivityTimeoutMs;
      return {
        ...base,
        status: 'active',
        detailCode: 'sandbox_ready',
        estimatedSleepAt: sleepAt !== null && sleepAt > observedAt ? sleepAt : null,
      };
    }
  }
}
