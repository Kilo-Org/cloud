import { CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE } from '@kilocode/worker-utils/sandbox-allocation';
import { isContainerConcurrencyLimitError } from '../container-concurrency.js';
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
import type {
  RuntimeLaunchOps,
  RuntimeReserveResult,
  RuntimeStartResult,
} from './runtime-launch.js';
import type { RuntimeLaunchObservation } from './runtime-launch-phase.js';
import { withDORetry } from '../utils/do-retry.js';
import { withTimeout } from '@kilocode/worker-utils';
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

export function createCloudflareContainersProviderAdapter(deps: {
  logicalSandboxId: string;
  allocationName: string;
  instance?: ContainerInstanceSize;
  egressAllowlist?: string[];
  getContainer: (logicalSandboxId: string) => DurableObjectStub<SandboxContainers>;
}): ProviderAdapter {
  const instance = deps.instance ?? CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE;
  const intentContainment = (intent: ProviderAllocationIntent): boolean =>
    Boolean(intent.containment?.kilocode || intent.containment?.github);
  const encodeIntentProviderRef = (intent: ProviderAllocationIntent): string =>
    encodeCloudflareProviderRef({
      sandboxId: intent.allocationName ?? deps.logicalSandboxId,
      containment: intentContainment(intent),
      instanceId: intent.intentId,
    });

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
    const container = deps.getContainer(deps.logicalSandboxId);
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
      } catch (error) {
        if (isContainerConcurrencyLimitError(error)) throw error;
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
      await withDORetry(
        () => deps.getContainer(deps.logicalSandboxId),
        container => container.configureBilling(input, instance),
        'configureSandboxContainersBilling'
      );
    }
  };

  return {
    ensureBillingAdmission,
    describeRuntime(ref) {
      const parsed = decodeOwnedProviderRef(ref);
      if (parsed === null) return undefined;
      return {
        provider: 'cloudflare-containers',
        sandboxId: deps.logicalSandboxId,
        instanceId: parsed.instanceId,
        instanceType: instance,
      };
    },
    async create(intent: ProviderCreateIntent) {
      const providerRef = encodeIntentProviderRef(intent);
      await ensureBillingAdmission(providerRef, intent.billing);
      return { providerRef };
    },
    runtimeExecution(intent): RuntimeLaunchOps | undefined {
      // Only a persisted launch token can bind a native reservation; without one
      // no ops exist and an explicit release selection fails before any work.
      const token = intent.launchToken;
      if (token === undefined) return undefined;
      const providerRef = encodeIntentProviderRef(intent);
      const containment = intentContainment(intent);
      const getContainer = () => deps.getContainer(deps.logicalSandboxId);
      const call = <T>(
        operationName: string,
        run: (stub: DurableObjectStub<SandboxContainers>) => Promise<T>,
        budgetMs: number = DEADLINE_MS.stopAttempt
      ): Promise<T> =>
        withTimeout(
          withDORetry<DurableObjectStub<SandboxContainers>, T>(getContainer, run, operationName),
          Math.max(1, budgetMs),
          `${operationName} timed out`
        );
      const remainingRpcMs = (deadlineAt: number) =>
        Math.max(1, Math.min(DEADLINE_MS.stopAttempt, deadlineAt - Date.now()));
      return {
        async reserveLaunch(input): Promise<RuntimeReserveResult> {
          // The durable native reservation commits first; billing admission
          // follows and, on failure, retires the reservation with no start.
          const reserved = await call<RuntimeReserveResult>(
            'reserveSandboxContainersLaunch',
            stub =>
              stub.reserveNativeLaunch({
                ...input,
                providerRef,
                instance,
                containment,
                ...(deps.egressAllowlist === undefined
                  ? {}
                  : { egressAllowlist: deps.egressAllowlist }),
              }),
            input.outerDeadlineAt > Date.now()
              ? remainingRpcMs(input.outerDeadlineAt)
              : DEADLINE_MS.stopAttempt
          );
          if (
            reserved.kind === 'refused' &&
            ['image_unavailable', 'invalid_launch_record', 'invalid_retirements'].includes(
              reserved.reason
            )
          )
            throw new ProviderCreationError('invalid_configuration');
          if (reserved.kind !== 'reserved' || Date.now() >= reserved.attemptDeadlineAt)
            return reserved;
          try {
            await withTimeout(
              ensureBillingAdmission(providerRef, intent.billing),
              remainingRpcMs(reserved.attemptDeadlineAt),
              'Native billing admission timed out'
            );
          } catch (error) {
            await call<void>('retireSandboxContainersLaunch', stub =>
              stub.retireNativeLaunch({
                providerRef,
                launchId: input.launchId,
                outerDeadlineAt: input.outerDeadlineAt,
              })
            ).catch(() => undefined);
            throw error;
          }
          return reserved;
        },
        async startLaunch(input): Promise<RuntimeStartResult> {
          try {
            return await call<RuntimeStartResult>(
              'startSandboxContainersLaunch',
              stub =>
                stub.startNativeLaunch({
                  ...input,
                  providerRef,
                  env: {
                    ...input.env,
                    CONTROL_WORKLOAD_LIMIT_MB:
                      input.env['CONTROL_WORKLOAD_LIMIT_MB'] ??
                      String(containersBillingIdentity(instance).capacity.memoryMiB),
                    PROVIDER_INSTANCE_ID: providerRef,
                    WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
                  },
                }),
              remainingRpcMs(input.attemptDeadlineAt)
            );
          } catch {
            // An exhausted or ambiguous transport is a normalized unknown, never
            // a rejection: the durable issuance fence reconciles it and the
            // physical start is never repeated.
            return { kind: 'unknown', reason: 'transport' };
          }
        },
        async observeLaunch(input) {
          try {
            return await call<RuntimeLaunchObservation>(
              'observeSandboxContainersLaunch',
              stub => stub.observeNativeLaunch(input),
              remainingRpcMs(input.deadlineAt)
            );
          } catch {
            // An observation transport failure is a process-unknown, reconciled
            // under the same nonce and bound.
            return { process: 'unknown' } as const;
          }
        },
        settleLaunch: input =>
          call<boolean>('settleSandboxContainersLaunch', stub => stub.settleNativeLaunch(input)),
        acknowledgeLaunch: input =>
          call<void>(
            'acknowledgeSandboxContainersLaunch',
            stub => stub.acknowledgeNativeLaunch(input),
            5_000
          ),
        retireLaunch: input =>
          call<void>('retireSandboxContainersLaunch', stub => stub.retireNativeLaunch(input)),
        destroyLaunch: input =>
          call<boolean>('destroySandboxContainersLaunch', stub => stub.destroyNativeLaunch(input)),
      };
    },
    async launch(ref, env, options) {
      const owned = decodeOwnedProviderRef(ref);
      if (owned === null) {
        throw new ProviderCreationError('invalid_configuration');
      }
      const container = deps.getContainer(deps.logicalSandboxId);
      const workloadLimitMb =
        env['CONTROL_WORKLOAD_LIMIT_MB'] ??
        String(containersBillingIdentity(instance).capacity.memoryMiB);
      const { startSource, snapshotFailed } = await container.launchWrapper({
        allocationRef: ref,
        instance,
        containment: owned.containment,
        ...(deps.egressAllowlist === undefined ? {} : { egressAllowlist: deps.egressAllowlist }),
        ...(options?.repoKey === undefined ? {} : { repoKey: options.repoKey }),
        ...(options?.skipRepository === true ? { skipRepository: true as const } : {}),
        ...(options?.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
        env: {
          ...env,
          CONTROL_WORKLOAD_LIMIT_MB: workloadLimitMb,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        },
      });
      if (snapshotFailed) return { startSource, snapshotFailed };
      // Lease renewal only starts once the wrapper reports ready, which the
      // recovery admission gate can delay. Establish the initial lease here so
      // the container is not reaped by its inactivity timeout before then.
      await container.ensureLeaseAtLeast(ref, leaseAtLeastMs()).catch(() => {
        logControlDiagnostic(
          'lease_renewal_failed',
          {
            allocationName: deps.allocationName,
            provider: 'cloudflare-containers',
            stage: 'launch',
          },
          'warn'
        );
      });
      return { startSource };
    },
    async captureRepository(ref, repoKey, commit) {
      if (decodeOwnedProviderRef(ref) === null) return false;
      try {
        return await deps
          .getContainer(deps.logicalSandboxId)
          .captureRepository(ref, repoKey, commit);
      } catch {
        return false;
      }
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
      const diagnostic = {
        provider: 'cloudflare-containers',
        allocationName: deps.logicalSandboxId,
        intentId: intent?.intentId,
      };
      // A null ref travels through with the exact captured token, so the DO uses
      // the current ref only when the nonce matches and never fabricates a ref.
      // A named ref must still be owned by this allocation, and a null ref with no
      // token cannot identify the plan.
      if (
        (ref !== null && decodeOwnedProviderRef(ref) === null) ||
        (ref === null && intent?.launchToken === undefined)
      ) {
        logControlDiagnostic('native_stop', { ...diagnostic, result: 'invalid_reference' });
        return 'retryable';
      }
      const startedAt = Date.now();
      logControlDiagnostic('native_stop', { ...diagnostic, result: 'started' });
      try {
        const result = await deps
          .getContainer(deps.logicalSandboxId)
          .stop(ref, intent?.launchToken);
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
