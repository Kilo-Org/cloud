import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
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

export function createCloudflareContainersProviderAdapter(deps: {
  logicalSandboxId: string;
  allocationName: string;
  instance?: ContainerInstanceSize;
  getContainer: (logicalSandboxId: string) => DurableObjectStub<SandboxContainers>;
}): ProviderAdapter {
  const instance = deps.instance ?? CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
  const encodeIntentProviderRef = (intent: ProviderAllocationIntent): string =>
    encodeCloudflareProviderRef({
      sandboxId: intent.allocationName ?? deps.logicalSandboxId,
      containment: false,
      instanceId: intent.intentId,
    });

  const resolveProviderRef = (
    ref: string | null,
    intent?: ProviderAllocationIntent | null
  ): string | null => ref ?? (intent ? encodeIntentProviderRef(intent) : null);

  const decodeOwnedProviderRef = (ref: string | null): CloudflareProviderRef | null => {
    const decoded = decodeCloudflareProviderRef(ref);
    return decoded !== null &&
      decoded.sandboxId === deps.allocationName &&
      decoded.containment === false
      ? decoded
      : null;
  };

  const ensureBillingAdmission: ProviderAdapter['ensureBillingAdmission'] = async (
    _ref,
    billing
  ) => {
    if (billing?.enforcementRequested) {
      throw new AgentSandboxUnavailableError('Container billing unavailable', 'billing_blocked');
    }
  };

  return {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    ensureBillingAdmission,
    async create(intent: ProviderCreateIntent) {
      if (intent.containment && (intent.containment.kilocode || intent.containment.github)) {
        throw new AgentSandboxUnavailableError(
          'Cloudflare containers do not support credential containment',
          'capability_unavailable'
        );
      }
      const providerRef = encodeIntentProviderRef(intent);
      await ensureBillingAdmission(providerRef, intent.billing);
      return { providerRef };
    },
    async launch(ref, env) {
      if (decodeOwnedProviderRef(ref) === null) {
        throw new Error('Invalid Cloudflare containers allocation');
      }
      const container = deps.getContainer(deps.logicalSandboxId);
      await container.launchWrapper({
        allocationRef: ref,
        instance,
        env: {
          ...env,
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
      if (providerRef === null) return { status: 'unknown' };
      try {
        const observation = await withDORetry(
          () => deps.getContainer(deps.logicalSandboxId),
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
      };
      if (resolved === null || decodeOwnedProviderRef(resolved) === null) {
        logControlDiagnostic('native_stop', { ...diagnostic, result: 'invalid_reference' });
        return 'retryable';
      }
      const startedAt = Date.now();
      logControlDiagnostic('native_stop', { ...diagnostic, result: 'started' });
      try {
        const result = await deps.getContainer(deps.logicalSandboxId).stop(resolved);
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
        () => deps.getContainer(deps.logicalSandboxId),
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
        return await deps
          .getContainer(deps.logicalSandboxId)
          .readLog(ref, CONTROL_WRAPPER_LOG_PATH, LOG_MAX_BYTES);
      } catch {
        return `cloudflare-containers ${ref} logs unavailable`;
      }
    },
  };
}
