import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import {
  containersBillingIdentity,
  parseSandboxBillingInput,
  type SandboxBillingAdmissionResult,
} from '../container-usage-context.js';
import type {
  ContainerInstanceSize,
  ContainersObservation,
  SandboxContainers,
} from '../sandbox-containers/SandboxContainers.js';
import { withDORetry } from '../utils/do-retry.js';
import {
  decodeCloudflareProviderRef,
  encodeCloudflareProviderRef,
  type CloudflareProviderRef,
} from './cloudflare-provider.js';
import { CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { DEADLINE_MS, leaseAtLeastMs } from './deadlines.js';
import { logControlDiagnostic } from './diagnostics.js';
import type {
  ObserveResult,
  ProviderAdapter,
  ProviderAllocationIntent,
  ProviderCreateIntent,
} from './provider.js';
import { ProviderCreationError } from './provider.js';

const LOG_MAX_BYTES = 1024 * 1024;

function mapObservation(
  observation: ContainersObservation,
  providerRef: string,
  intent: ProviderAllocationIntent | null | undefined
): ObserveResult {
  if (observation.state === 'idle') {
    if (observation.running) return 'unknown';
    return !intent || Date.now() >= intent.createdAt + DEADLINE_MS.createSettle
      ? 'terminal'
      : 'unknown';
  }
  if (observation.state === 'stopping') return 'unknown';
  if (observation.currentAllocationRef !== providerRef) return 'unknown';
  if (!observation.running) return 'unknown';
  return 'active';
}

/**
 * The container Durable Object name for a ref. Each allocation gets a fresh
 * container, so a wedged or stale one never blocks its replacement. Refs from
 * before per-allocation containers keep the logical sandbox's shared one.
 */
export function containerNameForRef(ref: CloudflareProviderRef, logicalSandboxId: string): string {
  return ref.container === 'allocation' ? `${ref.sandboxId}:${ref.instanceId}` : logicalSandboxId;
}

export function createCloudflareContainersProviderAdapter(deps: {
  logicalSandboxId: string;
  allocationName: string;
  instance?: ContainerInstanceSize;
  /** The managed outbound identity that contained credential grants are bound to. */
  outboundContainerId?: string;
  getContainer: (name: string) => DurableObjectStub<SandboxContainers>;
}): ProviderAdapter {
  const instance = deps.instance ?? CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
  const encodeIntentProviderRef = (intent: ProviderAllocationIntent): string =>
    encodeCloudflareProviderRef({
      sandboxId: intent.allocationName ?? deps.logicalSandboxId,
      containment: Boolean(intent.containment?.kilocode || intent.containment?.github),
      instanceId: intent.intentId,
      container: 'allocation',
    });
  const containerFor = (ref: CloudflareProviderRef): DurableObjectStub<SandboxContainers> =>
    deps.getContainer(containerNameForRef(ref, deps.logicalSandboxId));

  const resolveProviderRef = (
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): string | null => ref ?? (intent ? encodeIntentProviderRef(intent) : null);

  const decodeOwnedProviderRef = (ref: string | null): CloudflareProviderRef | null => {
    const decoded = decodeCloudflareProviderRef(ref);
    return decoded !== null && decoded.sandboxId === deps.allocationName ? decoded : null;
  };

  const ensureBillingAdmission: ProviderAdapter['ensureBillingAdmission'] = async (
    ref,
    billing
  ) => {
    if (!billing) return;
    const parsed = decodeOwnedProviderRef(ref);
    if (!parsed) throw new ProviderCreationError('invalid_configuration');
    let input: ReturnType<typeof parseSandboxBillingInput>;
    try {
      input = parseSandboxBillingInput(billing);
    } catch {
      throw new ProviderCreationError('invalid_configuration');
    }
    const container = containerFor(parsed);
    let blocked = false;
    try {
      blocked = await container.isBillingBlocked();
    } catch {
      blocked = input.enforcementRequested === true;
    }
    if (input.enforcementRequested || blocked) {
      let admission: SandboxBillingAdmissionResult;
      try {
        admission = await container.ensureBillingAdmission(input, instance);
      } catch {
        admission = {
          success: false,
          code: 'meter_unavailable',
          message: 'Container billing admission is unavailable',
        };
      }
      if (!admission.success) {
        throw new ProviderCreationError(admission.code);
      }
    } else {
      await container.configureBilling(input, instance).catch(() => undefined);
    }
  };

  return {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    // A per-allocation container answers only for its own ref; a legacy shared
    // container is fenced by `allocationRef`, so neither stop reaches another.
    allocationScopedStop: true,
    ensureBillingAdmission,
    async create(intent: ProviderCreateIntent) {
      const providerRef = encodeIntentProviderRef(intent);
      await ensureBillingAdmission(providerRef, intent.billing);
      return { providerRef };
    },
    async launch(ref, env) {
      const owned = decodeOwnedProviderRef(ref);
      if (owned === null) {
        throw new ProviderCreationError('invalid_configuration');
      }
      const container = containerFor(owned);
      const workloadLimitMb =
        env['CONTROL_WORKLOAD_LIMIT_MB'] ??
        String(containersBillingIdentity(instance).capacity.memoryMiB);
      await container.launchWrapper({
        allocationRef: ref,
        instance,
        containment: owned.containment,
        ...(deps.outboundContainerId === undefined
          ? {}
          : { outboundContainerId: deps.outboundContainerId }),
        env: {
          ...env,
          CONTROL_WORKLOAD_LIMIT_MB: workloadLimitMb,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        },
      });
      // Lease renewal only starts once the wrapper reports ready, which the
      // recovery admission gate can delay. Establish the initial lease here so
      // the container is not reaped by its inactivity timeout before then.
      await container.ensureLeaseAtLeast(ref, leaseAtLeastMs());
    },
    async observe(ref, intent) {
      const providerRef = resolveProviderRef(ref, intent);
      const decoded = decodeCloudflareProviderRef(providerRef);
      if (providerRef === null || decoded === null) return { status: 'unknown' };
      try {
        const observation = await withDORetry(
          () => containerFor(decoded),
          stub => stub.observe(providerRef),
          'observeSandboxContainers'
        );
        return { status: mapObservation(observation, providerRef, intent), providerRef };
      } catch {
        return { status: 'unknown', providerRef };
      }
    },
    async stop(ref, intent) {
      const resolved = resolveProviderRef(ref, intent);
      const diagnostic = {
        provider: 'cloudflare-containers',
        allocationName: deps.logicalSandboxId,
        intentId: intent?.intentId,
      };
      const owned = decodeOwnedProviderRef(resolved);
      if (resolved === null || owned === null) {
        logControlDiagnostic('native_stop', { ...diagnostic, result: 'invalid_reference' });
        return 'retryable';
      }
      const startedAt = Date.now();
      logControlDiagnostic('native_stop', { ...diagnostic, result: 'started' });
      try {
        const result = await containerFor(owned).stop(resolved);
        logControlDiagnostic('native_stop', {
          ...diagnostic,
          result,
          durationMs: Date.now() - startedAt,
        });
        return result;
      } catch {
        logControlDiagnostic(
          'native_stop',
          {
            ...diagnostic,
            result: 'retryable',
            durationMs: Date.now() - startedAt,
          },
          'warn'
        );
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const decoded = decodeCloudflareProviderRef(ref);
      if (decoded === null) {
        logControlDiagnostic('native_lease', {
          provider: 'cloudflare-containers',
          allocationName: deps.logicalSandboxId,
          requestedLeaseMs: ms,
          action: 'invalid_reference',
        });
        return;
      }
      await withDORetry(
        () => containerFor(decoded),
        stub => stub.ensureLeaseAtLeast(ref, ms),
        'ensureSandboxContainersLease'
      );
      logControlDiagnostic('native_lease', {
        provider: 'cloudflare-containers',
        allocationName: deps.logicalSandboxId,
        requestedLeaseMs: ms,
        action: 'activity_timeout_renewal',
      });
    },
    async logs(ref) {
      const decoded = decodeCloudflareProviderRef(ref);
      if (decoded === null) return `cloudflare-containers ${ref}`;
      try {
        return await containerFor(decoded).readLog(ref, CONTROL_WRAPPER_LOG_PATH, LOG_MAX_BYTES);
      } catch {
        return `cloudflare-containers ${ref} logs unavailable`;
      }
    },
  };
}
