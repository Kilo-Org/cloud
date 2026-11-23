import { normalizeAwsProviderFailure, withAwsFailurePolicy } from './aws-failure-policy.js';
import { ProviderLifecycleError, providerFailureReason } from './provider-failure.js';
import {
  AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import {
  AwsMicrovmRunRejectedError,
  type Microvm,
  type MicrovmClient,
} from '../agent-sandbox/aws/microvm-client.js';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import {
  ProviderCreationError,
  ProviderStoppedError,
  type ProviderAdapter,
  type ProviderLaunchResult,
} from './provider.js';
import { CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { logger } from '../logger.js';
import {
  decodeAwsProviderRef,
  encodeAwsProviderRef,
  awsOperationSchema,
  reserveAwsOperation,
  type AwsOperation,
  type AwsOperationStorage,
} from './aws-operation.js';

/** Replay is deliberately bounded; AWS does not document permanent token retention. */
export const AWS_LAUNCH_RECOVERY_MS = 5 * 60_000;
const LIFETIME_SHUTDOWN_MARGIN_MS = 120_000;

const PHASE_TRANSITIONS: Record<AwsOperation['phase'], readonly AwsOperation['phase'][]> = {
  created: ['launching', 'stopping'],
  launching: ['running', 'stopping', 'terminated'],
  running: ['stopping'],
  stopping: ['terminated'],
  terminated: [],
};

type AwsOperationEvent =
  | { type: 'prepared'; operation: AwsOperation }
  | { type: 'claim' }
  | { type: 'run-rejected'; attempt: 'first' | 'replay'; certainty: 'definite' | 'uncertain' }
  | { type: 'identified'; microvmId: string }
  | { type: 'running' | 'stop' | 'terminated' };

/** Pure recovery decision. Missing legacy submission certainty never proves an unsubmitted request. */
export function awsRecoveryStep(
  value: AwsOperation,
  now: number
): 'retired' | 'identified' | 'absent' | 'unsubmitted' | 'replay' | 'blocked' {
  if (value.phase === 'terminated') return 'retired';
  if (value.microvmId) return 'identified';
  if (!value.request) return 'absent';
  if (value.submission === 'prepared') return 'unsubmitted';
  return value.requestAt !== undefined && now - value.requestAt > AWS_LAUNCH_RECOVERY_MS
    ? 'blocked'
    : 'replay';
}

/** All durable phase changes stay here. The shell supplies observations and performs I/O. */
export function transitionAwsOperation(
  current: AwsOperation,
  event: AwsOperationEvent,
  now: number
): AwsOperation {
  let next = current;
  switch (event.type) {
    case 'prepared':
      if (current.phase === 'stopping' || current.phase === 'terminated')
        throw new Error('AWS allocation is stopping');
      if (current.phase === 'created') next = event.operation;
      break;
    case 'claim':
      if (
        current.phase === 'terminated' ||
        (current.phase === 'stopping' && current.submission === 'prepared')
      )
        throw new ProviderStoppedError();
      if (current.microvmId) break;
      if (!current.request || current.requestAt === undefined)
        throw new ProviderCreationError('invalid_configuration');
      if (awsRecoveryStep(current, now) === 'blocked')
        throw new ProviderCreationError('cleanup_required');
      next = {
        ...current,
        submission: current.submission === 'prepared' ? 'pending' : 'uncertain',
      };
      break;
    case 'run-rejected':
      if (current.phase === 'terminated' || current.microvmId) break;
      next =
        event.certainty === 'definite' &&
        event.attempt === 'first' &&
        current.submission === 'pending'
          ? { ...current, phase: 'terminated' }
          : { ...current, submission: 'uncertain' };
      break;
    case 'identified':
      if (current.phase === 'terminated') break;
      if (current.microvmId && current.microvmId !== event.microvmId)
        throw new Error('AWS launch identity changed');
      next = { ...current, microvmId: event.microvmId };
      break;
    case 'running':
      if (current.phase === 'launching') next = { ...current, phase: 'running' };
      break;
    case 'stop':
      if (current.phase !== 'terminated') next = { ...current, phase: 'stopping' };
      break;
    case 'terminated':
      next = {
        ref: current.ref,
        config: current.config,
        phase: 'terminated',
        ...(current.microvmId ? { microvmId: current.microvmId } : {}),
      };
      break;
  }
  if (next.phase !== current.phase && !PHASE_TRANSITIONS[current.phase].includes(next.phase))
    throw new ProviderCreationError('invalid_configuration');
  return next;
}

export type AwsProviderAdapter = ProviderAdapter & {
  reconcileLaunch(ref: string): Promise<ProviderLaunchResult | undefined>;
  lifetimeDeadlineAt(ref: string): Promise<number | undefined>;
  confirmAdmission(ref: string): Promise<void>;
  validateWrapperAdmission(ref: string): Promise<void>;
};

export type AwsRuntimeAccess = {
  config: AwsByocConfiguration;
  client: MicrovmClient;
  objects: AwsObjectStore;
};

export function createAwsProviderAdapter(deps: {
  sandboxId: string;
  resolveRuntime: (configuration?: AwsByocConfiguration) => Promise<AwsRuntimeAccess>;
  storage: AwsOperationStorage;
  now?: () => number;
}): AwsProviderAdapter {
  const now = deps.now ?? Date.now;
  function owned(raw: string | null) {
    const ref = decodeAwsProviderRef(raw);
    return ref?.sandboxId === deps.sandboxId ? ref : null;
  }
  async function operation(raw: string): Promise<AwsOperation> {
    const ref = owned(raw);
    if (!ref) throw new ProviderCreationError('invalid_configuration');
    const parsed = awsOperationSchema.safeParse(await deps.storage.get(ref.intentId));
    if (!parsed.success || encodeAwsProviderRef(parsed.data.ref) !== raw)
      throw new ProviderCreationError('invalid_configuration');
    return parsed.data;
  }
  function change(value: AwsOperation, transition: (current: AwsOperation) => AwsOperation) {
    return deps.storage.update(value.ref.intentId, raw => {
      const current = awsOperationSchema.parse(raw);
      if (encodeAwsProviderRef(current.ref) !== encodeAwsProviderRef(value.ref))
        throw new ProviderCreationError('invalid_configuration');
      return transition(current);
    });
  }
  /** The bucket's launch document expiry rule is the backstop; a confirmed stop stays terminal. */
  async function deleteLaunchBestEffort(value: AwsOperation) {
    try {
      const { objects } = await deps.resolveRuntime(value.config);
      await objects.deleteLaunch(`kilo/launch/${value.ref.intentId}.json`);
    } catch (error) {
      logger
        .withTags({ logTag: 'aws_launch_document_cleanup_failed', sandboxId: deps.sandboxId })
        .withFields({ errorName: error instanceof Error ? error.name : 'unknown' })
        .warn('AWS launch document cleanup failed after a confirmed stop');
    }
  }
  function verify(vm: Microvm, value: AwsOperation) {
    const request = value.request;
    if (
      !request ||
      vm.imageArn !== request.imageIdentifier ||
      vm.imageVersion !== request.imageVersion ||
      JSON.stringify(vm.ingressNetworkConnectors) !==
        JSON.stringify(request.ingressNetworkConnectors) ||
      JSON.stringify(vm.egressNetworkConnectors) !==
        JSON.stringify(request.egressNetworkConnectors) ||
      vm.executionRoleArn != null ||
      vm.idlePolicy != null ||
      vm.maximumDurationInSeconds !== request.maximumDurationInSeconds
    )
      throw new ProviderLifecycleError('provider_identity_mismatch');
  }
  function assertRecoverable(value: AwsOperation) {
    if (awsRecoveryStep(value, now()) === 'blocked')
      throw new ProviderCreationError('cleanup_required');
  }
  async function recover(value: AwsOperation): Promise<AwsOperation> {
    if (value.microvmId) return value;
    if (!value.request || value.requestAt === undefined)
      throw new ProviderCreationError('invalid_configuration');
    assertRecoverable(value);
    const { client } = await deps.resolveRuntime(value.config);
    value = await change(value, current =>
      transitionAwsOperation(current, { type: 'claim' }, now())
    );
    if (value.microvmId) return value;
    if (!value.request) throw new ProviderCreationError('invalid_configuration');
    const attempt = value.submission === 'pending' ? 'first' : 'replay';
    let response: Microvm;
    try {
      response = await client.run(value.request);
    } catch (error) {
      await change(value, current =>
        transitionAwsOperation(
          current,
          {
            type: 'run-rejected',
            attempt,
            certainty: error instanceof AwsMicrovmRunRejectedError ? 'definite' : 'uncertain',
          },
          now()
        )
      );
      throw error;
    }
    // Keep identity before validation so cleanup can terminate an unexpected allocation.
    return change(value, current =>
      transitionAwsOperation(current, { type: 'identified', microvmId: response.microvmId }, now())
    );
  }

  async function inspect(value: AwsOperation): Promise<Microvm> {
    if (!value.microvmId) throw new Error('AWS launch identity is unresolved');
    const vm = await (await deps.resolveRuntime(value.config)).client.get(value.microvmId);
    verify(vm, value);
    return vm;
  }
  const launched: ProviderLaunchResult = { startSource: 'image' };
  async function completeLaunch(value: AwsOperation): Promise<ProviderLaunchResult> {
    assertRecoverable(value);
    if (value.phase === 'stopping' || value.phase === 'terminated')
      throw new Error('AWS allocation is stopping');
    value = await recover(value);
    const vm = await inspect(value);
    if (vm.state === 'TERMINATED' || vm.state === 'TERMINATING') throw new ProviderStoppedError();
    value = await change(value, current =>
      transitionAwsOperation(current, { type: 'running' }, now())
    );
    if (value.phase !== 'running') throw new Error('AWS allocation is stopping');
    return launched;
  }
  const adapter: AwsProviderAdapter = {
    describeRuntime(ref) {
      const identity = owned(ref);
      return identity
        ? {
            provider: 'aws',
            sandboxId: deps.sandboxId,
            instanceId: identity.intentId,
            region: 'us-east-1',
            instanceType: 'microvm-8g',
          }
        : undefined;
    },
    ensureBillingAdmission: async () => {},
    async create(intent) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(intent.intentId))
        throw new ProviderCreationError('invalid_configuration');
      const existing = awsOperationSchema.safeParse(await deps.storage.get(intent.intentId));
      if (existing.success) {
        if (existing.data.ref.sandboxId !== deps.sandboxId)
          throw new ProviderCreationError('invalid_configuration');
        assertRecoverable(existing.data);
        return { providerRef: encodeAwsProviderRef(existing.data.ref) };
      }
      // A new intent cannot abandon an older allocation whose stop is unconfirmed.
      for (const [, raw] of await deps.storage.list()) {
        const previous = awsOperationSchema.parse(raw);
        if (previous.phase === 'terminated') continue;
        assertRecoverable(previous);
        if ((await adapter.stop(encodeAwsProviderRef(previous.ref))) !== 'terminal')
          throw new ProviderCreationError('stopping');
      }
      const { config } = await deps.resolveRuntime();
      const value: AwsOperation = {
        ref: {
          provider: 'aws',
          sandboxId: deps.sandboxId,
          intentId: intent.intentId,
          createdAt: intent.createdAt,
        },
        config,
        phase: 'created',
      };
      const reserved = await reserveAwsOperation(deps.storage, value);
      return { providerRef: encodeAwsProviderRef(reserved.ref) };
    },
    async launch(ref, startup, options) {
      if (options?.snapshot) throw new ProviderCreationError('invalid_configuration');
      let value = await operation(ref);
      if (value.phase === 'terminated' || value.phase === 'stopping')
        throw new Error('AWS allocation is stopping');
      if (!value.request) {
        const { objects } = await deps.resolveRuntime(value.config);
        if (startup.command.argv.length === 0 || startup.command.argv.length > 64)
          throw new ProviderCreationError('invalid_configuration');
        const deadlineAt = Math.min(
          options?.deadlineAt ?? now() + AWS_LAUNCH_RECOVERY_MS,
          now() + AWS_LAUNCH_RECOVERY_MS
        );
        const env = {
          ...startup.env,
          PROVIDER_INSTANCE_ID: ref,
          WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
        };
        const document = JSON.stringify({ format: 1, deadlineAt, argv: startup.command.argv, env });
        if (new TextEncoder().encode(document).byteLength > 262_144)
          throw new ProviderCreationError('invalid_configuration');
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(document));
        const sha256 = Array.from(new Uint8Array(digest), byte =>
          byte.toString(16).padStart(2, '0')
        ).join('');
        const launchKey = `kilo/launch/${value.ref.intentId}.json`;
        const url = await objects.downloadUrl(launchKey, 600);
        const payload = JSON.stringify({ url, sha256, deadlineAt });
        if (new TextEncoder().encode(payload).byteLength > 16_384)
          throw new ProviderCreationError('invalid_configuration');
        try {
          await objects.putLaunch(launchKey, document);
        } catch (error) {
          if (error instanceof AwsRequestError && error.status === 412) {
            const current = await operation(ref);
            if (current.request) return completeLaunch(current);
          }
          throw error;
        }
        const prepared: AwsOperation = {
          ...value,
          phase: 'launching',
          submission: 'prepared',
          requestAt: now(),
          deadlineAt:
            now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000 - LIFETIME_SHUTDOWN_MARGIN_MS,
          request: {
            clientToken: value.ref.intentId,
            imageIdentifier: value.config.imageIdentifier,
            imageVersion: value.config.imageVersion,
            ingressNetworkConnectors: [
              `arn:aws:lambda:${value.config.region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
            ],
            egressNetworkConnectors: [value.config.connectorArn],
            logging: { disabled: {} },
            maximumDurationInSeconds: AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
            runHookPayload: payload,
          },
        };
        // An upload can orphan only a TTL-bound object. This checkpoint precedes compute creation.
        value = await change(value, current =>
          transitionAwsOperation(current, { type: 'prepared', operation: prepared }, now())
        );
      }
      return completeLaunch(value);
    },
    async reconcileLaunch(ref) {
      const value = await operation(ref);
      assertRecoverable(value);
      if (!value.request) return undefined;
      // A known live wrapper remains the liveness signal. Reconciliation does not poll that VM.
      if (value.phase === 'running' && value.microvmId) return launched;
      if (value.phase === 'stopping' || value.phase === 'terminated')
        throw new Error('AWS allocation is stopping');
      return completeLaunch(value);
    },
    async observe(ref) {
      if (ref === null || !owned(ref)) return { status: 'unknown' };
      try {
        const value = await operation(ref);
        if (value.phase === 'terminated') return { status: 'terminal' };
        if (!value.microvmId) return { status: 'unknown' };
        const vm = await inspect(value);
        return {
          status:
            vm.state === 'TERMINATED'
              ? 'terminal'
              : vm.state === 'TERMINATING'
                ? 'unknown'
                : 'active',
        };
      } catch {
        return { status: 'unknown' };
      }
    },
    async stop(ref, intent) {
      if (ref === null && intent) {
        const value = awsOperationSchema.safeParse(await deps.storage.get(intent.intentId));
        if (!value.success) return 'terminal';
        ref = encodeAwsProviderRef(value.data.ref);
      }
      if (ref === null || !owned(ref)) return 'retryable';
      try {
        let value = await operation(ref);
        if (value.phase === 'terminated') {
          await deleteLaunchBestEffort(value);
          return 'terminal';
        }
        value = await change(value, current =>
          transitionAwsOperation(current, { type: 'stop' }, now())
        );
        if (value.request && value.submission !== 'prepared') {
          const { client } = await deps.resolveRuntime(value.config);
          value = await recover(value);
          if (!value.microvmId) return 'retryable';
          // Cleanup needs only the owned identity, even when runtime configuration validation failed.
          await client.terminate(value.microvmId);
          if ((await client.get(value.microvmId)).state !== 'TERMINATED') return 'retryable';
        }
        // Compute termination must survive a launch document cleanup failure.
        await change(value, current =>
          transitionAwsOperation(current, { type: 'terminated' }, now())
        );
        await deleteLaunchBestEffort(value);
        return 'terminal';
      } catch (error) {
        const failure = normalizeAwsProviderFailure(error);
        if (providerFailureReason(failure)) throw failure;
        return 'retryable';
      }
    },
    async ensureLeaseAtLeast(ref, ms) {
      const value = await operation(ref);
      if (value.deadlineAt !== undefined && now() + ms >= value.deadlineAt)
        throw new Error('AWS allocation lifetime cannot be extended');
    },
    async lifetimeDeadlineAt(ref) {
      return (await operation(ref)).deadlineAt;
    },
    async validateWrapperAdmission(ref) {
      const value = await operation(ref);
      if (value.phase === 'running' && value.microvmId) return;
      if (!value.request) throw new ProviderCreationError('invalid_configuration');
      await completeLaunch(value);
    },
    async confirmAdmission(ref) {
      let value = await operation(ref);
      if (value.request && !value.microvmId) value = await recover(value);
      await (
        await deps.resolveRuntime(value.config)
      ).objects.deleteLaunch(`kilo/launch/${value.ref.intentId}.json`);
    },
    async logs(ref) {
      await operation(ref);
      return 'AWS bootstrap logs are unavailable. Wrapper logs use the shared upload path.';
    },
  };
  return {
    ...adapter,
    create: withAwsFailurePolicy(adapter.create.bind(adapter)),
    launch: withAwsFailurePolicy(adapter.launch.bind(adapter)),
    stop: withAwsFailurePolicy(adapter.stop.bind(adapter)),
    reconcileLaunch: withAwsFailurePolicy(adapter.reconcileLaunch.bind(adapter)),
    validateWrapperAdmission: withAwsFailurePolicy(adapter.validateWrapperAdmission.bind(adapter)),
    confirmAdmission: withAwsFailurePolicy(adapter.confirmAdmission.bind(adapter)),
  };
}
