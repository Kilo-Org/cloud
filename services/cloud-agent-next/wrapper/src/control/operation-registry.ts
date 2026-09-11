import { isDeepStrictEqual } from 'node:util';
import {
  SANDBOX_CONTROL_OPERATION_LIMIT,
  sessionOperationAuthorizationSchema,
  sessionOperationAckSchema,
  sessionOperationExpiresAt,
  type SessionOperationAuthorization,
  type SessionRequestIdentity,
} from '../../../src/shared/sandbox-control-protocol.js';
import { rejectBeforeAdmission } from './control-handler-result.js';
import { rootForSession } from './session-directories.js';
import type { WorktreeKiloRuntime, WorktreeKiloRuntimes } from './worktree-runtime.js';
import type {
  NativeOperationTarget,
  NativeRetirement,
  RootScopedCleanupResult,
} from './session-operation-cleanup.js';
import {
  SessionOperation,
  type ControlHandlerResult,
  type SessionOperationDependencies,
  type SessionOperationWork,
} from './session-operation.js';

type OperationRegistryDependencies = {
  native: {
    get(identity: SessionRequestIdentity): ReturnType<WorktreeKiloRuntimes['get']>;
    getEntryRuntimeId?(directory: string, root: string): string | undefined;
    getRetained(directory: string, runtimeId?: string): WorktreeKiloRuntime | undefined;
    prepareForNewWork?(directory: string): boolean;
    retireRuntime(
      directory: string,
      deadlineAt: number,
      target?: NativeOperationTarget
    ): Promise<NativeRetirement>;
    retireRuntimeIfUnshared?(
      directory: string,
      target: NativeOperationTarget,
      retiringRoot: string,
      deadlineAt: number,
      reason?: string
    ): Promise<NativeRetirement | 'shared'>;
    rootRetirementScope?(
      directory: string,
      target: NativeOperationTarget,
      retiringRoot: string
    ): 'shared' | 'sole' | 'stale';
    verifyQuiescence(
      directory: string,
      target: NativeOperationTarget,
      deadlineAt: number
    ): Promise<boolean>;
  };
  onStarted: (session: SessionRequestIdentity, preparation: boolean) => void;
  onCompleted: (session: SessionRequestIdentity) => void;
  retireRuntime: (reason: string) => void;
};

type OperationEffects = Pick<
  SessionOperationDependencies,
  'signal' | 'emitSessionEvent' | 'sendOperationResult' | 'onDiagnostic'
>;

type Admission =
  | { kind: 'continue' }
  | { kind: 'reply'; result: ControlHandlerResult | Promise<ControlHandlerResult> };

type ScopedFailure = {
  root: string;
  nativeRuntimeId: string;
  directory: string;
  target?: NativeOperationTarget;
  deadlineAt: number;
  cleanup: Promise<RootScopedCleanupResult>;
  fullCleanup: Promise<RootScopedCleanupResult>;
  physical?: PhysicalState;
  result?: RootScopedCleanupResult;
  claim: symbol;
  superseded: boolean;
};

type PhysicalState = {
  promise: Promise<RootPublicationDisposition>;
  disposition?: RootPublicationDisposition;
  attempt?: PromiseWithResolvers<RootPublicationDisposition>;
  attemptId?: string;
};

type RootPublicationInput = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target?: NativeOperationTarget;
  reason: string;
  deadlineAt: number;
  expectedClaim?: symbol;
};

export type RootPublicationDisposition = {
  scope: 'root' | 'runtime';
  status: 'aborted' | 'already_idle' | 'unconfirmed';
  cleanup: RootScopedCleanupResult;
  physical: NativeRetirement | 'shared' | 'pending' | 'not_attempted';
  quiescent: boolean;
  runtimeRetired: boolean;
  physicalAttemptStarted: boolean;
};

type ArchivedScopedClaim = {
  root: string;
  nativeRuntimeId: string;
  directory: string;
  target?: NativeOperationTarget;
  cleanup: Promise<RootScopedCleanupResult>;
};

type RootPhysicalAttempt = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target: NativeOperationTarget;
  retirementId: string;
};

type RootPublicationSettlement = {
  directory: string;
  root: string;
  nativeRuntimeId: string;
  target?: NativeOperationTarget;
  result: NativeRetirement;
  retirementId?: string;
};

type RootPublicationDisappearance = Omit<RootPublicationSettlement, 'result'>;

function key(authorization: SessionOperationAuthorization): string {
  return JSON.stringify([
    authorization.session.sessionId,
    authorization.operation,
    authorization.operationId,
  ]);
}

function ok(result: unknown): ControlHandlerResult {
  return { ok: true, result };
}

function fail(code: string, message: string, retryable: boolean): ControlHandlerResult {
  return { ok: false, error: { code, message, retryable } };
}

function makeRootPublicationDisposition(
  scope: 'root' | 'runtime',
  cleanup: RootScopedCleanupResult,
  physical: RootPublicationDisposition['physical'],
  physicalAttemptStarted = physical === 'retired' || physical === 'unconfirmed'
): RootPublicationDisposition {
  const runtimeRetired = physical === 'retired';
  return {
    scope,
    status:
      scope === 'root' && cleanup === 'confirmed'
        ? 'aborted'
        : runtimeRetired
          ? 'aborted'
          : 'unconfirmed',
    cleanup,
    physical,
    quiescent: runtimeRetired,
    runtimeRetired,
    physicalAttemptStarted,
  };
}

function makeSupersededRootPublicationDisposition(): RootPublicationDisposition {
  return {
    scope: 'runtime',
    status: 'already_idle',
    cleanup: 'confirmed',
    physical: 'not_attempted',
    quiescent: false,
    runtimeRetired: false,
    physicalAttemptStarted: false,
  };
}

const ROOT_SCOPED_WORK = new Set(['session.attach', 'session.prompt', 'session.terminal.create']);

export function createOperationRegistry(deps: OperationRegistryDependencies) {
  const active = new Map<string, SessionOperation>();
  const retained = new Map<string, SessionOperation>();
  const scopedFailures = new Map<string, ScopedFailure>();
  const archivedClaims = new Map<symbol, ArchivedScopedClaim>();

  function scopedFailureKey(root: string, nativeRuntimeId: string): string {
    return JSON.stringify([root, nativeRuntimeId]);
  }

  function currentRuntime(directory: string, nativeRuntimeId: string) {
    return deps.native.getRetained(directory, nativeRuntimeId);
  }

  function installPhysical(
    failure: ScopedFailure,
    promise: Promise<RootPublicationDisposition>,
    disposition?: RootPublicationDisposition
  ): PhysicalState {
    const physical: PhysicalState = { promise };
    if (disposition !== undefined) physical.disposition = disposition;
    failure.physical = physical;
    if (disposition === undefined) {
      void promise.then(
        settled => {
          if (failure.physical === physical) {
            physical.disposition = settled;
          }
        },
        () => undefined
      );
    }
    return physical;
  }

  function installPhysicalAttempt(failure: ScopedFailure, retirementId: string): PhysicalState {
    const attempt = Promise.withResolvers<RootPublicationDisposition>();
    const physical: PhysicalState = {
      promise: attempt.promise,
      attempt,
      attemptId: retirementId,
    };
    failure.physical = physical;
    failure.result = 'unconfirmed';
    return physical;
  }

  function compatibleTarget(
    left: NativeOperationTarget | undefined,
    right: NativeOperationTarget | undefined
  ): boolean {
    return (
      left === undefined ||
      right === undefined ||
      (left.runtimeId === right.runtimeId &&
        (left.client === undefined || right.client === undefined || left.client === right.client))
    );
  }

  function claimHasOwner(claim: symbol): boolean {
    return (
      [...active.values()].some(operation => operation.publicationScope()?.claim === claim) ||
      [...retained.values()].some(operation => operation.publicationScope()?.claim === claim)
    );
  }

  function removeOrphanedArchivedClaims(): void {
    for (const claim of archivedClaims.keys()) {
      if (!claimHasOwner(claim)) archivedClaims.delete(claim);
    }
  }

  function clearStaleScopedFailures(): void {
    for (const [id, failure] of scopedFailures) {
      const currentId = deps.native.getEntryRuntimeId
        ? deps.native.getEntryRuntimeId(failure.directory, failure.root)
        : currentRuntime(failure.directory, failure.nativeRuntimeId)?.runtimeId;
      if (
        deps.native.getEntryRuntimeId
          ? currentId !== failure.nativeRuntimeId
          : currentId !== undefined && currentId !== failure.nativeRuntimeId
      )
        scopedFailures.delete(id);
    }
    removeOrphanedArchivedClaims();
  }

  function archiveSupersededFailure(failure: ScopedFailure): void {
    if (!failure.superseded || failure.result !== 'confirmed') return;
    if (!claimHasOwner(failure.claim)) {
      archivedClaims.delete(failure.claim);
      return;
    }
    archivedClaims.set(failure.claim, {
      root: failure.root,
      nativeRuntimeId: failure.nativeRuntimeId,
      directory: failure.directory,
      target: failure.target,
      cleanup: failure.cleanup,
    });
  }

  function archivedClaimMatches(
    input: RootPublicationInput,
    archived: ArchivedScopedClaim
  ): boolean {
    return (
      archived.root === input.root &&
      archived.nativeRuntimeId === input.nativeRuntimeId &&
      archived.directory === input.directory &&
      compatibleTarget(archived.target, input.target)
    );
  }

  function matchingPublicationOperations(input: RootPublicationInput): SessionOperation[] {
    return [...active.values()].filter(operation => {
      if (operation.session.directory !== input.directory) return false;
      if (rootForSession(operation.session.kiloSessionId, input.directory) !== input.root)
        return false;
      const operationTarget = operation.nativeTarget();
      return (
        operationTarget?.runtimeId === input.nativeRuntimeId &&
        compatibleTarget(operationTarget, input.target)
      );
    });
  }

  function createScopedFailure(
    input: RootPublicationInput,
    matching: SessionOperation[]
  ): Promise<RootScopedCleanupResult> {
    const claim = Symbol('publication-scoped-failure');
    for (const operation of matching)
      operation.markPublicationScoped(input.reason, input.deadlineAt, claim);
    const cleanup = (async (): Promise<RootScopedCleanupResult> => {
      if (matching.length === 0) return 'unconfirmed';
      const results = await Promise.all(
        matching.map(operation => operation.runRootScopedCleanup())
      );
      return results.every(result => result === 'confirmed') ? 'confirmed' : 'unconfirmed';
    })().catch(() => 'unconfirmed' as const);
    const fullCleanup = (async (): Promise<RootScopedCleanupResult> => {
      if (matching.length === 0) return 'unconfirmed';
      const results = await Promise.all(
        matching.map(operation => operation.waitForRootScopedCleanup())
      );
      return results.every(result => result === 'confirmed') ? 'confirmed' : 'unconfirmed';
    })().catch(() => 'unconfirmed' as const);
    const failure: ScopedFailure = {
      root: input.root,
      nativeRuntimeId: input.nativeRuntimeId,
      directory: input.directory,
      cleanup,
      fullCleanup,
      deadlineAt: input.deadlineAt,
      claim,
      superseded: false,
    };
    failure.target = input.target;
    failure.deadlineAt = input.deadlineAt;
    failure.cleanup = cleanup;
    scopedFailures.set(scopedFailureKey(input.root, input.nativeRuntimeId), failure);
    void cleanup.then(result => {
      if (scopedFailures.get(scopedFailureKey(input.root, input.nativeRuntimeId)) === failure)
        failure.result = result;
    });
    void fullCleanup.then(result => {
      if (scopedFailures.get(scopedFailureKey(input.root, input.nativeRuntimeId)) === failure)
        failure.result = result;
    });
    return cleanup;
  }

  function retireRootPublication(input: RootPublicationInput): Promise<RootScopedCleanupResult> {
    const id = scopedFailureKey(input.root, input.nativeRuntimeId);
    clearStaleScopedFailures();
    let existing = scopedFailures.get(id);
    if (input.expectedClaim !== undefined) {
      if (
        existing &&
        existing.claim === input.expectedClaim &&
        compatibleTarget(existing.target, input.target)
      )
        return existing.cleanup;
      const archived = archivedClaims.get(input.expectedClaim);
      return archived && archivedClaimMatches(input, archived)
        ? archived.cleanup
        : Promise.resolve('unconfirmed');
    }
    if (existing) archiveSupersededFailure(existing);
    if (existing && !compatibleTarget(existing.target, input.target)) {
      scopedFailures.delete(id);
      removeOrphanedArchivedClaims();
      existing = undefined;
    } else if (existing && existing.result !== 'confirmed') {
      return existing.cleanup;
    }
    const matching = matchingPublicationOperations(input);
    return createScopedFailure(input, matching);
  }

  function escalateRootPublication(input: RootPublicationInput): {
    cleanup: Promise<RootScopedCleanupResult>;
    physical: Promise<RootPublicationDisposition>;
    disposition: () => RootPublicationDisposition;
  } {
    const id = scopedFailureKey(input.root, input.nativeRuntimeId);
    clearStaleScopedFailures();
    const current = scopedFailures.get(id);
    const scopeFor = (): 'root' | 'runtime' =>
      deps.native.rootRetirementScope?.(
        input.directory,
        input.target ?? { runtimeId: input.nativeRuntimeId },
        input.root
      ) === 'shared'
        ? 'root'
        : 'runtime';
    const staleDisposition = () =>
      makeRootPublicationDisposition('runtime', 'unconfirmed', 'stale');
    if (
      current?.superseded === true &&
      input.expectedClaim !== undefined &&
      current.claim === input.expectedClaim &&
      compatibleTarget(current.target, input.target)
    ) {
      return {
        cleanup: current.cleanup,
        physical: Promise.resolve(makeSupersededRootPublicationDisposition()),
        disposition: makeSupersededRootPublicationDisposition,
      };
    }
    const archived =
      input.expectedClaim === undefined ? undefined : archivedClaims.get(input.expectedClaim);
    if (archived && archivedClaimMatches(input, archived)) {
      return {
        cleanup: archived.cleanup,
        physical: Promise.resolve(makeSupersededRootPublicationDisposition()),
        disposition: makeSupersededRootPublicationDisposition,
      };
    }
    if (current?.superseded === true && input.expectedClaim !== undefined) {
      return {
        cleanup: Promise.resolve('unconfirmed'),
        physical: Promise.resolve(staleDisposition()),
        disposition: staleDisposition,
      };
    }
    if (input.expectedClaim !== undefined && current?.claim !== input.expectedClaim) {
      return {
        cleanup: Promise.resolve('unconfirmed'),
        physical: Promise.resolve(staleDisposition()),
        disposition: staleDisposition,
      };
    }
    const cleanup = retireRootPublication(input);
    const failure = scopedFailures.get(id);
    if (!failure) {
      return {
        cleanup,
        physical: Promise.resolve(staleDisposition()),
        disposition: staleDisposition,
      };
    }
    const readDisposition = (): RootPublicationDisposition => {
      const physical = failure.physical;
      if (physical?.disposition) return physical.disposition;
      if (physical?.attempt)
        return makeRootPublicationDisposition(
          'runtime',
          failure.result ?? 'unconfirmed',
          'pending',
          true
        );
      return makeRootPublicationDisposition(scopeFor(), failure.result ?? 'unconfirmed', 'pending');
    };
    if (failure.physical?.disposition?.scope === 'root' && scopeFor() !== 'root') {
      failure.physical = undefined;
    }
    if (failure.physical) {
      return {
        cleanup,
        physical: failure.physical.promise,
        disposition: readDisposition,
      };
    }
    const physical = installPhysical(
      failure,
      failure.cleanup.then(async cleanupResult => {
        if (scopedFailures.get(id) !== failure)
          return makeRootPublicationDisposition('runtime', cleanupResult, 'stale');
        const scope = scopeFor();
        if (cleanupResult === 'confirmed' && scope === 'root') {
          const disposition = makeRootPublicationDisposition(
            'root',
            cleanupResult,
            'not_attempted'
          );
          if (failure.physical === physical) physical.disposition = disposition;
          return disposition;
        }
        const retirement =
          (await deps.native.retireRuntimeIfUnshared?.(
            input.directory,
            input.target ?? { runtimeId: input.nativeRuntimeId },
            input.root,
            input.deadlineAt,
            input.reason
          )) ?? 'unconfirmed';
        if (retirement === 'retired' || retirement === 'stale') {
          if (scopedFailures.get(id) !== failure)
            return makeRootPublicationDisposition('runtime', cleanupResult, retirement);
          settleRootPublication({
            directory: input.directory,
            root: input.root,
            nativeRuntimeId: input.nativeRuntimeId,
            target: input.target,
            result: retirement,
          });
        }
        const disposition =
          retirement === 'shared'
            ? makeRootPublicationDisposition('root', cleanupResult, retirement)
            : makeRootPublicationDisposition('runtime', cleanupResult, retirement);
        if (failure.physical === physical) physical.disposition = disposition;
        return disposition;
      })
    );
    return {
      cleanup,
      physical: physical.promise,
      disposition: readDisposition,
    };
  }

  function settleRootPublication(input: RootPublicationSettlement): void {
    const id = scopedFailureKey(input.root, input.nativeRuntimeId);
    const failure = scopedFailures.get(id);
    if (!failure || failure.directory !== input.directory) return;
    if (!compatibleTarget(failure.target, input.target)) return;
    const physical = failure.physical;
    if (physical?.attempt) {
      if (input.retirementId !== undefined && input.retirementId !== physical.attemptId) return;
      const disposition = makeRootPublicationDisposition(
        'runtime',
        failure.result ?? 'unconfirmed',
        input.result,
        true
      );
      physical.attempt.resolve(disposition);
      installPhysical(failure, Promise.resolve(disposition), disposition);
      if (input.result === 'retired' || input.result === 'stale') {
        scopedFailures.delete(id);
        removeOrphanedArchivedClaims();
      } else failure.result = 'unconfirmed';
      return;
    }
    if (input.result === 'retired' || input.result === 'stale') {
      scopedFailures.delete(id);
      removeOrphanedArchivedClaims();
    } else failure.result = 'unconfirmed';
  }

  function markRootRetirementStarted(input: RootPhysicalAttempt): void {
    const id = scopedFailureKey(input.root, input.nativeRuntimeId);
    const failure = scopedFailures.get(id);
    if (
      !failure ||
      failure.directory !== input.directory ||
      !compatibleTarget(failure.target, input.target)
    )
      return;
    if (failure.physical?.attempt) {
      if (failure.physical.attemptId === undefined) failure.physical.attemptId = input.retirementId;
      return;
    }
    installPhysicalAttempt(failure, input.retirementId);
  }

  function settleScopedFailuresForIncarnation(
    directory: string,
    target: NativeOperationTarget,
    result: NativeRetirement
  ): void {
    if (result !== 'retired' && result !== 'stale') return;
    for (const [id, failure] of scopedFailures) {
      if (
        failure.directory === directory &&
        failure.nativeRuntimeId === target.runtimeId &&
        compatibleTarget(failure.target, target)
      )
        scopedFailures.delete(id);
    }
    removeOrphanedArchivedClaims();
  }

  function notifyRootDisappeared(input: RootPublicationDisappearance): void {
    const id = scopedFailureKey(input.root, input.nativeRuntimeId);
    const failure = scopedFailures.get(id);
    if (failure?.directory === input.directory && compatibleTarget(failure.target, input.target))
      scopedFailures.delete(id);
    removeOrphanedArchivedClaims();
  }

  function markSupersededRootClaims(
    session: SessionRequestIdentity,
    work: SessionOperationWork
  ): void {
    if (!ROOT_SCOPED_WORK.has(work.operation)) return;
    clearStaleScopedFailures();
    const root = rootForSession(session.kiloSessionId, session.directory);
    if (!root) return;
    const runtimeId = work.operation === 'session.prompt' ? work.runtime.runtimeId : undefined;
    for (const failure of scopedFailures.values()) {
      if (
        failure.result === 'confirmed' &&
        failure.directory === session.directory &&
        failure.root === root &&
        (runtimeId === undefined || failure.nativeRuntimeId === runtimeId)
      )
        failure.superseded = true;
    }
  }

  function publicationFailureBlocks(operation: string, session: SessionRequestIdentity): boolean {
    if (!ROOT_SCOPED_WORK.has(operation)) return false;
    clearStaleScopedFailures();
    const root = rootForSession(session.kiloSessionId, session.directory);
    if (!root) return false;
    const runtime = deps.native.get(session);
    for (const failure of scopedFailures.values()) {
      if (
        failure.directory === session.directory &&
        failure.root === root &&
        failure.result !== 'confirmed' &&
        (runtime === undefined || runtime.runtimeId === failure.nativeRuntimeId)
      )
        return true;
    }
    return false;
  }

  function prune(now = Date.now()): void {
    for (const [id, operation] of retained) {
      if (!operation.canPrune(now)) continue;
      if (operation.releaseProcessOwnership()) {
        retained.delete(id);
        removeOrphanedArchivedClaims();
      } else {
        const deadlineAt = operation.captureCleanupDeadline();
        void operation
          .cleanupOwnedWork(deadlineAt)
          .catch(() => false)
          .then(confirmed => {
            if (retained.get(id) !== operation) return;
            const released = operation.releaseProcessOwnership();
            if (!confirmed || !released) operation.reportUnreapedProcessCleanup(!released);
            retained.delete(id);
            removeOrphanedArchivedClaims();
          });
      }
    }
    clearStaleScopedFailures();
  }

  function admission(
    operation: string,
    session: SessionRequestIdentity,
    payload: unknown,
    authorization?: SessionOperationAuthorization
  ): Admission {
    clearStaleScopedFailures();
    if (operation !== 'session.operation.get' && !authorization) {
      if (publicationFailureBlocks(operation, session))
        return {
          kind: 'reply',
          result: rejectBeforeAdmission('not_ready', 'Native runtime cleanup is unconfirmed', true),
        };
      return { kind: 'continue' };
    }
    const reply = (result: ControlHandlerResult | Promise<ControlHandlerResult>): Admission => ({
      kind: 'reply',
      result,
    });
    const parsed = sessionOperationAuthorizationSchema.safeParse(
      operation === 'session.operation.get' ? payload : authorization
    );
    if (!parsed.success)
      return reply(
        rejectBeforeAdmission('protocol_error', 'Invalid operation authorization', false)
      );
    const target = parsed.data;
    if (!isDeepStrictEqual(target.session, session))
      return reply(rejectBeforeAdmission('unauthorized', 'Operation target mismatch', false));
    if (operation !== 'session.operation.get' && target.operation !== operation)
      return reply(
        rejectBeforeAdmission('unauthorized', 'Operation authorization mismatch', false)
      );
    if (Date.now() >= sessionOperationExpiresAt(target))
      return reply(rejectBeforeAdmission('not_ready', 'Operation authorization expired', false));
    prune();
    const existing = retained.get(key(target));
    if (existing) {
      if (!existing.matchesAuthorization(target) || !isDeepStrictEqual(existing.session, session))
        return reply(
          rejectBeforeAdmission('idempotency_conflict', 'Operation identity mismatch', false)
        );
      if (operation === 'session.operation.get') {
        const delivery = existing.deliveryResult();
        return reply(
          ok(
            delivery
              ? { state: 'completed', delivery }
              : {
                  state: 'running',
                  authorization: target,
                  ...(existing.executionDeadlineAt
                    ? { executionDeadlineAt: existing.executionDeadlineAt }
                    : {}),
                }
          )
        );
      }
      try {
        if (!existing.matchesIntent(payload))
          return reply(
            rejectBeforeAdmission('idempotency_conflict', 'Operation intent mismatch', false)
          );
      } catch {
        return reply(rejectBeforeAdmission('protocol_error', 'Invalid payload', false));
      }
      return reply(
        operation === 'session.attach'
          ? existing.done
          : ok({
              messageId: target.messageId,
              status: 'existing',
              executionDeadlineAt: existing.executionDeadlineAt,
            })
      );
    }
    if (operation === 'session.operation.get') return reply(ok({ state: 'missing' }));
    if (publicationFailureBlocks(operation, session))
      return reply(
        rejectBeforeAdmission('not_ready', 'Native runtime cleanup is unconfirmed', true)
      );
    if (Date.now() >= target.dispatchDeadlineAt)
      return reply(
        rejectBeforeAdmission('not_ready', 'Operation dispatch authorization expired', false)
      );
    if (retained.size >= SANDBOX_CONTROL_OPERATION_LIMIT)
      return reply(
        rejectBeforeAdmission('session_busy', 'Operation receipt capacity is unavailable', true)
      );
    return { kind: 'continue' };
  }

  async function acknowledge(
    session: SessionRequestIdentity,
    payload: unknown
  ): Promise<ControlHandlerResult> {
    const parsed = sessionOperationAckSchema.safeParse(payload);
    if (!parsed.success || !isDeepStrictEqual(parsed.data.authorization.session, session))
      return fail('unauthorized', 'Invalid operation acknowledgement', false);
    const id = key(parsed.data.authorization);
    const operation = retained.get(id);
    if (!operation) return fail('unauthorized', 'Operation acknowledgement is not current', false);
    return (await operation.acknowledge(parsed.data, () => retained.get(id) === operation))
      ? ok({ acknowledged: true })
      : fail('unauthorized', 'Operation acknowledgement does not match the result', false);
  }

  async function retireDirectory(
    directory: string,
    reason: string,
    deadlineAt: number,
    target?: NativeOperationTarget
  ): Promise<NativeRetirement> {
    const matching = [...active.values()].filter(operation => {
      if (operation.session.directory !== directory) return false;
      const operationTarget = operation.nativeTarget();
      return target === undefined || operationTarget?.runtimeId === target.runtimeId;
    });
    for (const operation of matching) operation.cancel(reason, 'failed', deadlineAt);
    if (
      !(await Promise.all(matching.map(operation => operation.stopProcesses(deadlineAt)))).every(
        Boolean
      )
    )
      return 'unconfirmed';
    const retirement = await deps.native.retireRuntime(directory, deadlineAt, target);
    for (const operation of matching)
      operation.confirmCleanup(retirement === 'retired' || retirement === 'stale', deadlineAt);
    if (target) settleScopedFailuresForIncarnation(directory, target, retirement);
    return retirement;
  }

  function start(
    session: SessionRequestIdentity,
    authorization: SessionOperationAuthorization | undefined,
    work: SessionOperationWork,
    effects: OperationEffects
  ): SessionOperation {
    const identity = Object.freeze({ ...session });
    const operation = new SessionOperation(identity, authorization, work, {
      ...effects,
      isCurrent: () => active.get(identity.kiloSessionId) === operation,
      getRuntime: () => deps.native.get(identity),
      prepareForNewWork: () => deps.native.prepareForNewWork?.(identity.directory) ?? true,
      verifyQuiescence: (target, deadlineAt) =>
        deps.native.verifyQuiescence(identity.directory, target, deadlineAt),
      retireRuntime: (reason, deadlineAt, target) => {
        if (!target) {
          deps.retireRuntime(reason);
          return;
        }
        const retiringRoot =
          rootForSession(identity.kiloSessionId, identity.directory) ?? identity.kiloSessionId;
        const retirement = deps.native.retireRuntimeIfUnshared
          ? deps.native.retireRuntimeIfUnshared(
              identity.directory,
              target,
              retiringRoot,
              deadlineAt,
              reason
            )
          : deps.native.rootRetirementScope?.(identity.directory, target, retiringRoot) === 'shared'
            ? Promise.resolve<'shared'>('shared')
            : retireDirectory(identity.directory, reason, deadlineAt, target);
        void retirement.then(retirement => {
          if (retirement === 'unconfirmed') deps.retireRuntime(reason);
        });
      },
      onLocalCompletion: retain => {
        if (active.get(identity.kiloSessionId) === operation) {
          active.delete(identity.kiloSessionId);
          deps.onCompleted(identity);
        }
        if (authorization && !retain && retained.get(key(authorization)) === operation)
          retained.delete(key(authorization));
        removeOrphanedArchivedClaims();
      },
      onCleanupConfirmed: () => undefined,
    });
    markSupersededRootClaims(identity, work);
    if (authorization) retained.set(key(authorization), operation);
    active.set(identity.kiloSessionId, operation);
    deps.onStarted(identity, work.operation === 'session.attach');
    return operation;
  }

  return {
    admission,
    acknowledge,
    retireRootPublication,
    escalateRootPublication,
    settleRootPublication,
    markRootRetirementStarted,
    notifyRootDisappeared,
    start,
    prune,
    active: (rootKiloSessionId: string) => active.get(rootKiloSessionId),
    abortTarget(session: SessionRequestIdentity, messageId?: string) {
      const current = active.get(session.kiloSessionId);
      if (
        current &&
        isDeepStrictEqual(current.session, session) &&
        (messageId === undefined || current.messageId === messageId)
      ) {
        return current;
      }
      if (messageId === undefined) return undefined;
      const matches = [...retained.values()].filter(
        operation =>
          operation.messageId === messageId && isDeepStrictEqual(operation.session, session)
      );
      return matches.find(operation => operation.kind !== 'preparation') ?? matches[0];
    },
    hasActive: (rootKiloSessionId: string) => active.has(rootKiloSessionId),
    activeOperations: () => [...active.values()],
    retireDirectory,
    retained: () => [...retained.values()],
    counts: () => ({ active: active.size, retained: retained.size, archived: archivedClaims.size }),
    async drainDelivery(deadlineAt: number): Promise<void> {
      const timeout = Math.max(0, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...retained.values()].map(operation => operation.waitForDelivery())),
          new Promise<void>(resolve => {
            timer = setTimeout(resolve, timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

export type OperationRegistry = ReturnType<typeof createOperationRegistry>;
