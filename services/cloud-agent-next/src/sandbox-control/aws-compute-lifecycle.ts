import { normalizeAwsProviderFailure, withAwsFailurePolicy } from './aws-failure-policy.js';
import { providerFailureReason } from './provider-failure.js';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import {
  ProviderCreationError,
  ProviderStoppedError,
  ProviderSnapshotCreationError,
  type ProviderSnapshotStart,
  type ProviderAdapter,
  type ProviderLaunchResult,
  type ProviderStartup,
} from './provider.js';
import { uploadAwsLaunchDocument, type AwsLaunchEnvelope } from './aws-launch-document.js';
import { logger } from '../logger.js';

/** Replay is bounded; neither engine promises permanent idempotency-token retention. */
export const AWS_LAUNCH_RECOVERY_MS = 5 * 60_000;
export type AwsComputeRef = { sandboxId: string; intentId: string; createdAt: number };
export type AwsComputeOperation<Config, Ref extends AwsComputeRef, Request> = {
  ref: Ref;
  config: Config;
  phase: 'created' | 'launching' | 'running' | 'stopping' | 'terminated';
  request?: Request;
  requestAt?: number;
  /** Missing legacy certainty never proves that the request was not submitted. */
  submission?: 'prepared' | 'pending' | 'uncertain';
  physicalId?: string;
  deadlineAt?: number;
  /** Absent on existing base-image launches. Written atomically with the issued request. */
  startSource?: 'repository';
};
export type AwsComputeStorage<Record> = {
  get(id: string): Promise<unknown>;
  update(id: string, transition: (value: unknown) => Record): Promise<Record>;
  list(): Promise<Map<string, unknown>>;
  delete(id: string): Promise<void>;
};
export type AwsComputeAdapter = ProviderAdapter & {
  reconcileLaunch(ref: string): Promise<ProviderLaunchResult | undefined>;
  lifetimeDeadlineAt(ref: string): Promise<number | undefined>;
  confirmAdmission(ref: string): Promise<void>;
  validateWrapperAdmission(ref: string): Promise<void>;
};
export type AwsPrepareSnapshot<Config, Ref> = (input: {
  startup: ProviderStartup;
  ref: Ref;
  configuration: Config;
  snapshot: ProviderSnapshotStart;
  deadlineAt: number;
}) => Promise<ProviderStartup>;
/**
 * Engine observation of the identified compute. `active` records `running`. `pending` (accepted,
 * not yet running) and `unknown` (no evidence) keep `launching`: launch returns success, and
 * wrapper admission rejects until a later inspection is `active`. `stopping` and `terminal` stop.
 */
export type AwsComputeStatus = 'active' | 'pending' | 'stopping' | 'terminal' | 'unknown';

const PHASE_TRANSITIONS: Record<
  AwsComputeOperation<unknown, AwsComputeRef, unknown>['phase'],
  readonly AwsComputeOperation<unknown, AwsComputeRef, unknown>['phase'][]
> = {
  created: ['launching', 'stopping'],
  launching: ['running', 'stopping', 'terminated'],
  running: ['stopping'],
  stopping: ['terminated'],
  terminated: [],
};

type AwsOperationEvent<Config, Ref extends AwsComputeRef, Request> =
  | { type: 'prepared'; operation: AwsComputeOperation<Config, Ref, Request> }
  | { type: 'claim' }
  | { type: 'run-rejected'; attempt: 'first' | 'replay'; certainty: 'definite' | 'uncertain' }
  | { type: 'identified'; physicalId: string }
  | { type: 'running' | 'stop' | 'terminated' };

/** Pure recovery decision. Missing legacy submission certainty never proves an unsubmitted request. */
export function awsRecoveryStep<Config, Ref extends AwsComputeRef, Request>(
  value: AwsComputeOperation<Config, Ref, Request>,
  now: number
): 'retired' | 'identified' | 'absent' | 'unsubmitted' | 'replay' | 'blocked' {
  if (value.phase === 'terminated') return 'retired';
  if (value.physicalId) return 'identified';
  if (!value.request) return 'absent';
  if (value.submission === 'prepared') return 'unsubmitted';
  return value.requestAt !== undefined && now - value.requestAt > AWS_LAUNCH_RECOVERY_MS
    ? 'blocked'
    : 'replay';
}

/** All durable phase changes stay here. The shell supplies observations and performs I/O. */
export function transitionAwsOperation<Config, Ref extends AwsComputeRef, Request>(
  current: AwsComputeOperation<Config, Ref, Request>,
  event: AwsOperationEvent<Config, Ref, Request>,
  now: number
): AwsComputeOperation<Config, Ref, Request> {
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
      if (current.physicalId) break;
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
      if (current.phase === 'terminated' || current.physicalId) break;
      next =
        event.certainty === 'definite' &&
        event.attempt === 'first' &&
        current.submission === 'pending'
          ? { ...current, phase: 'terminated' }
          : { ...current, submission: 'uncertain' };
      break;
    case 'identified':
      if (current.phase === 'terminated') break;
      if (current.physicalId && current.physicalId !== event.physicalId)
        throw new Error('AWS launch identity changed');
      next = { ...current, physicalId: event.physicalId };
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
        ...(current.physicalId ? { physicalId: current.physicalId } : {}),
      };
      break;
  }
  if (next.phase !== current.phase && !PHASE_TRANSITIONS[current.phase].includes(next.phase))
    throw new ProviderCreationError('invalid_configuration');
  return next;
}

/** The lifecycle owns durable ordering. Engine codecs preserve each provider's stored contract. */
export function createAwsComputeLifecycle<
  Config,
  Ref extends AwsComputeRef,
  Request,
  Record,
>(deps: {
  sandboxId: string;
  storage: AwsComputeStorage<Record>;
  codec: {
    read(value: unknown): AwsComputeOperation<Config, Ref, Request>;
    write(value: AwsComputeOperation<Config, Ref, Request>): Record;
    encodeRef(ref: Ref): string;
    decodeRef(raw: string | null): Ref | null;
    newRef(intent: { intentId: string; createdAt: number }): Ref;
  };
  resolveConfiguration(): Promise<Config>;
  objects(config: Config): Promise<AwsObjectStore>;
  prepareStartup(input: {
    startup: ProviderStartup;
    ref: Ref;
    configuration: Config;
  }): Promise<ProviderStartup>;
  prepareSnapshot?: AwsPrepareSnapshot<Config, Ref>;
  engine: {
    prepare(
      config: Config,
      ref: Ref,
      envelope: AwsLaunchEnvelope
    ): Promise<{ request: Request; deadlineAt?: number }>;
    discover?(value: AwsComputeOperation<Config, Ref, Request>): Promise<string | undefined>;
    runner(config: Config): Promise<(request: Request) => Promise<string>>;
    isDefiniteRunRejection(error: unknown): boolean;
    inspect(value: AwsComputeOperation<Config, Ref, Request>): Promise<AwsComputeStatus>;
    stop(config: Config, physicalId: string): Promise<'terminal' | 'retryable'>;
  };
  describeRuntime?: ProviderAdapter['describeRuntime'];
  now?: () => number;
}): AwsComputeAdapter {
  type Operation = AwsComputeOperation<Config, Ref, Request>;
  const now = deps.now ?? Date.now;
  const { codec } = deps;
  function read(raw: unknown): Operation {
    try {
      return codec.read(raw);
    } catch {
      throw new ProviderCreationError('invalid_configuration');
    }
  }
  function owned(raw: string | null) {
    const ref = codec.decodeRef(raw);
    return ref?.sandboxId === deps.sandboxId ? ref : null;
  }
  async function operation(raw: string): Promise<Operation> {
    const ref = owned(raw);
    if (!ref) throw new ProviderCreationError('invalid_configuration');
    const value = read(await deps.storage.get(ref.intentId));
    if (codec.encodeRef(value.ref) !== raw)
      throw new ProviderCreationError('invalid_configuration');
    return value;
  }
  async function change(value: Operation, transition: (current: Operation) => Operation) {
    return read(
      await deps.storage.update(value.ref.intentId, raw => {
        const current = read(raw);
        if (codec.encodeRef(current.ref) !== codec.encodeRef(value.ref))
          throw new ProviderCreationError('invalid_configuration');
        return codec.write(transition(current));
      })
    );
  }
  /** The bucket's launch document expiry rule is the backstop; a confirmed stop stays terminal. */
  async function deleteLaunchBestEffort(value: Operation) {
    try {
      await (
        await deps.objects(value.config)
      ).deleteLaunch(`kilo/launch/${value.ref.intentId}.json`);
    } catch (error) {
      logger
        .withTags({ logTag: 'aws_launch_document_cleanup_failed', sandboxId: deps.sandboxId })
        .withFields({ errorName: error instanceof Error ? error.name : 'unknown' })
        .warn('AWS launch document cleanup failed after a confirmed stop');
    }
  }
  async function recoverExpired(value: Operation): Promise<Operation> {
    if (awsRecoveryStep(value, now()) !== 'blocked') return value;
    const physicalId = await deps.engine.discover?.(value);
    // Recheck storage after discovery. Another caller may already have found or stopped the task.
    value = await change(value, current =>
      physicalId
        ? transitionAwsOperation(current, { type: 'identified', physicalId }, now())
        : current
    );
    if (awsRecoveryStep(value, now()) === 'blocked')
      throw new ProviderCreationError('cleanup_required');
    return value;
  }
  async function recover(value: Operation): Promise<Operation> {
    if (value.physicalId) return value;
    if (!value.request || value.requestAt === undefined)
      throw new ProviderCreationError('invalid_configuration');
    value = await recoverExpired(value);
    if (value.physicalId) return value;
    const run = await deps.engine.runner(value.config);
    value = await recoverExpired(await operation(codec.encodeRef(value.ref)));
    if (value.physicalId) return value;
    value = await change(value, current =>
      transitionAwsOperation(current, { type: 'claim' }, now())
    );
    if (value.physicalId) return value;
    if (!value.request) throw new ProviderCreationError('invalid_configuration');
    const attempt = value.submission === 'pending' ? 'first' : 'replay';
    let physicalId: string;
    try {
      physicalId = await run(value.request);
    } catch (error) {
      await change(value, current =>
        transitionAwsOperation(
          current,
          {
            type: 'run-rejected',
            attempt,
            certainty: deps.engine.isDefiniteRunRejection(error) ? 'definite' : 'uncertain',
          },
          now()
        )
      );
      throw error;
    }
    // Store identity before metadata admission. Cleanup must survive admission rejection.
    return change(value, current =>
      transitionAwsOperation(current, { type: 'identified', physicalId }, now())
    );
  }
  const launched = (value: Operation): ProviderLaunchResult => ({
    startSource: value.startSource ?? 'image',
  });
  async function completeLaunch(value: Operation): Promise<ProviderLaunchResult> {
    if (value.phase === 'stopping' || value.phase === 'terminated')
      throw new Error('AWS allocation is stopping');
    value = await recover(value);
    const status = await deps.engine.inspect(value);
    if (status === 'terminal' || status === 'stopping') throw new ProviderStoppedError();
    value = await change(value, current =>
      status === 'active' && current.phase === 'launching'
        ? transitionAwsOperation(current, { type: 'running' }, now())
        : current
    );
    if (value.phase === 'stopping' || value.phase === 'terminated')
      throw new Error('AWS allocation is stopping');
    return launched(value);
  }
  const adapter: AwsComputeAdapter = {
    environmentSnapshots: deps.prepareSnapshot ? 'launch' : undefined,
    describeRuntime: deps.describeRuntime,
    ensureBillingAdmission: async () => {},
    async create(intent) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(intent.intentId))
        throw new ProviderCreationError('invalid_configuration');
      const existing = await deps.storage.get(intent.intentId);
      if (existing !== undefined) {
        const value = read(existing);
        if (value.ref.sandboxId !== deps.sandboxId)
          throw new ProviderCreationError('invalid_configuration');
        await recoverExpired(value);
        return { providerRef: codec.encodeRef(value.ref) };
      }
      // The coordinator dispatches cross-provider cleanup. Each history retains its own engine authority.
      const history = await deps.storage.list();
      for (const raw of history.values()) {
        const previous = read(raw);
        if (previous.phase === 'terminated') continue;
        if ((await adapter.stop(codec.encodeRef(previous.ref))) !== 'terminal')
          throw new ProviderCreationError('stopping');
      }
      const value: Operation = {
        ref: codec.newRef(intent),
        config: await deps.resolveConfiguration(),
        phase: 'created',
      };
      const entries = await deps.storage.list();
      for (const [id, raw] of entries) {
        if (entries.size < 32) break;
        if (read(raw).phase !== 'terminated') continue;
        await deps.storage.delete(id);
        entries.delete(id);
      }
      if (entries.size >= 32) throw new Error('AWS allocation cleanup requires attention');
      const reserved = read(
        await deps.storage.update(intent.intentId, current =>
          current === undefined ? codec.write(value) : codec.write(read(current))
        )
      );
      return { providerRef: codec.encodeRef(reserved.ref) };
    },
    async launch(ref, startup, options) {
      if (options?.snapshot && !deps.prepareSnapshot)
        throw new ProviderCreationError('invalid_configuration');
      let value = await operation(ref);
      if (value.phase === 'terminated' || value.phase === 'stopping')
        throw new Error('AWS allocation is stopping');
      if (!value.request) {
        startup = await deps.prepareStartup({
          startup,
          ref: value.ref,
          configuration: value.config,
        });
        if (options?.snapshot && deps.prepareSnapshot) {
          try {
            startup = await deps.prepareSnapshot({
              startup,
              ref: value.ref,
              configuration: value.config,
              snapshot: options.snapshot,
              deadlineAt: Math.min(options.deadlineAt ?? Infinity, now() + AWS_LAUNCH_RECOVERY_MS),
            });
          } catch (error) {
            if (error instanceof ProviderSnapshotCreationError)
              return {
                startSource: 'repository',
                snapshotFailed: true,
                snapshotFailureReason: error.reason,
              };
            throw error;
          }
        }
        const objects = await deps.objects(value.config);
        try {
          let envelope: AwsLaunchEnvelope;
          try {
            envelope = await uploadAwsLaunchDocument({
              objects,
              startup,
              providerRef: ref,
              intentId: value.ref.intentId,
              deadlineAt: Math.min(options?.deadlineAt ?? Infinity, now() + AWS_LAUNCH_RECOVERY_MS),
            });
          } catch (error) {
            if (error instanceof AwsRequestError && error.status === 412) {
              const current = await operation(ref);
              if (current.request) return completeLaunch(current);
            }
            throw error;
          }
          const prepared = await deps.engine.prepare(value.config, value.ref, envelope);
          // The exact request is checkpointed only while created, before any compute request.
          value = await change(value, current =>
            transitionAwsOperation(
              current,
              {
                type: 'prepared',
                operation: {
                  ...current,
                  ...prepared,
                  phase: 'launching',
                  submission: 'prepared',
                  requestAt: now(),
                  ...(options?.snapshot ? { startSource: 'repository' as const } : {}),
                },
              },
              now()
            )
          );
        } catch (error) {
          const current = await operation(ref);
          // No Run can use this document without its durable request. A late PUT must not outlive Stop.
          if (!current.request && (current.phase === 'stopping' || current.phase === 'terminated'))
            await objects.deleteLaunch(`kilo/launch/${value.ref.intentId}.json`);
          throw error;
        }
      }
      return completeLaunch(value);
    },
    async reconcileLaunch(ref) {
      const value = await operation(ref);
      if (!value.request) return undefined;
      if (value.phase === 'running' && value.physicalId) return launched(value);
      return completeLaunch(value);
    },
    async observe(ref) {
      if (ref === null || !owned(ref)) return { status: 'unknown' };
      try {
        const value = await operation(ref);
        if (value.phase === 'terminated') return { status: 'terminal' };
        if (!value.physicalId) return { status: 'unknown' };
        const status = await deps.engine.inspect(value);
        return {
          status:
            status === 'terminal'
              ? 'terminal'
              : status === 'active' || status === 'pending'
                ? 'active'
                : 'unknown',
        };
      } catch {
        return { status: 'unknown' };
      }
    },
    async stop(ref, intent) {
      if (ref === null && intent) {
        const raw = await deps.storage.get(intent.intentId);
        if (raw === undefined) return 'terminal';
        // An unreadable record is permanent. Report it as stop(ref) does, not as retryable.
        ref = codec.encodeRef(read(raw).ref);
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
          value = await recover(value);
          if (
            !value.physicalId ||
            (await deps.engine.stop(value.config, value.physicalId)) !== 'terminal'
          )
            return 'retryable';
        }
        // Persist confirmed termination before fallible object cleanup.
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
      let value = await operation(ref);
      if (value.phase === 'running' && value.physicalId) return;
      if (!value.request) throw new ProviderCreationError('invalid_configuration');
      await completeLaunch(value);
      value = await operation(ref);
      if (value.phase !== 'running') throw new Error('AWS allocation is not ready');
    },
    async confirmAdmission(ref) {
      let value = await operation(ref);
      if (value.request && !value.physicalId) value = await recover(value);
      await (
        await deps.objects(value.config)
      ).deleteLaunch(`kilo/launch/${value.ref.intentId}.json`);
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
