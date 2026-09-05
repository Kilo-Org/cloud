import {
  SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS,
  sandboxReconcileResultSchema,
  sandboxStatusResultSchema,
} from '../shared/sandbox-control-protocol.js';
import * as recovery from './control-recovery.js';
import {
  loadDeadlines,
  loadRecoveryDecisions,
  saveDeadlines,
  saveRecoveryDecisions,
} from './durable-state.js';
import { armDeadline, cancelDeadline, DEADLINE_MS, type DeadlineTable } from './deadlines.js';
import type { PhysicalRecord } from './physical-lifecycle.js';
import type { SandboxControlConnectionIdentity, SandboxControlSocketHandler } from './socket.js';
import { SandboxControlConnectionError } from './waiters.js';

export type RecoveryExecutionRuntime = Readonly<{
  identity: SandboxControlConnectionIdentity;
  isCurrent: () => boolean;
  acceptsPhysical: (physical: PhysicalRecord) => boolean;
}>;

type Dependencies = {
  storage: Pick<DurableObjectStorage, 'transaction'>;
  sendRequest: SandboxControlSocketHandler['sendRequest'];
  loadPhysical: () => Promise<PhysicalRecord>;
  loadAuthority: (
    decision: recovery.SandboxRecoveryDecision
  ) => Promise<recovery.RecoveryAuthority | undefined>;
  onReady: (
    identity: SandboxControlConnectionIdentity,
    decision: recovery.SandboxRecoveryDecision
  ) => Promise<boolean>;
  reconcileStops: (
    authority: recovery.RecoveryAuthority
  ) => Promise<recovery.RecoveryScopeResult[]>;
  reconcileOperations: (
    authority: recovery.RecoveryAuthority
  ) => Promise<recovery.RecoveryScopeResult[]>;
  onActivated: (identity: SandboxControlConnectionIdentity) => void;
  scheduleAlarm: (deadlines: DeadlineTable) => Promise<void>;
};

export function createRecoveryExecution(dependencies: Dependencies) {
  const pending = new Map<string, Promise<boolean>>();

  async function reconcile(runtime: RecoveryExecutionRuntime): Promise<boolean> {
    if (!runtime.identity.recoveryCapable || !runtime.isCurrent()) return false;
    const initialClaimed = await dependencies.storage.transaction(async tx => {
      const records = await loadRecoveryDecisions(tx);
      const current = records.find(
        item => item.wrapperInstanceId === runtime.identity.wrapperInstanceId
      );
      const attempt = recovery.claimAttempt(current, runtime.identity, Date.now());
      if (!attempt) return;
      await saveRecoveryDecisions(
        tx,
        records.map(item => (item === current ? attempt.recovery : item))
      );
      const deadlines = recovery.recoveryDeadlines(
        await loadDeadlines(tx),
        records.map(item => (item === current ? attempt.recovery : item))
      );
      await saveDeadlines(tx, deadlines);
      await dependencies.scheduleAlarm(deadlines);
      return attempt;
    });
    if (!initialClaimed) return false;
    let claimed = initialClaimed;
    const persist = async (
      update: (
        current: recovery.SandboxRecoveryDecision
      ) => recovery.SandboxRecoveryDecision | undefined,
      finishActivation = false
    ) => {
      const saved = await dependencies.storage.transaction(async tx => {
        const records = await loadRecoveryDecisions(tx);
        const current = records.find(item => item.episodeId === claimed.recovery.episodeId);
        if (!current || !recovery.sameConnection(current, runtime.identity) || !runtime.isCurrent())
          throw new SandboxControlConnectionError('Recovery authority changed', false);
        const next = update(current);
        const remaining = next
          ? records.map(item => (item === current ? next : item))
          : records.filter(item => item !== current);
        let deadlines = recovery.recoveryDeadlines(await loadDeadlines(tx), remaining);
        if (
          current.activationCommittedAt !== undefined &&
          current.activationAcknowledgedAt === undefined &&
          (next === undefined || next.activationAcknowledgedAt !== undefined)
        ) {
          await tx.put(recovery.ACTIVE_WRAPPER_RUNTIME_KEY, {
            ...runtime.identity,
            readyConnectionId: runtime.identity.connectionId,
          });
          await tx.put(recovery.WRAPPER_READY_AT_KEY, current.activationCommittedAt);
          deadlines = armDeadline(
            cancelDeadline(deadlines, 'wrapperReadiness'),
            'heartbeatExpiry',
            Date.now() + DEADLINE_MS.heartbeatExpiry
          );
        }
        await saveRecoveryDecisions(tx, remaining);
        await saveDeadlines(tx, deadlines);
        if (finishActivation) await dependencies.scheduleAlarm(deadlines);
        return { next, deadlines };
      });
      if (saved.next) claimed = { ...claimed, recovery: saved.next };
      if (!finishActivation) await dependencies.scheduleAlarm(saved.deadlines);
    };
    try {
      const repairingActivation = recovery.activationRepairPending(claimed.recovery);
      const episodeDeadlineAt = () =>
        recovery.activationRepairPending(claimed.recovery)
          ? (claimed.recovery.activationCommitDeadlineAt ?? claimed.recovery.deadlineAt)
          : claimed.recovery.deadlineAt;
      const requestDeadlineAt = () =>
        Math.min(episodeDeadlineAt(), Date.now() + SANDBOX_CONTROL_RECOVERY_ATTEMPT_TIMEOUT_MS);
      const assertCurrent = async () => {
        if (
          !runtime.isCurrent() ||
          Date.now() >= episodeDeadlineAt() ||
          (!recovery.activationRepairPending(claimed.recovery) &&
            !runtime.acceptsPhysical(await dependencies.loadPhysical()))
        )
          throw new SandboxControlConnectionError('Recovery attempt expired', false);
      };
      const phase = async (phase: 'drain' | 'ready' | 'commit') => {
        const deadlineAt = requestDeadlineAt();
        const response = await dependencies.sendRequest({
          operation: 'sandbox.reconcile',
          expectedWrapperInstanceId: runtime.identity.wrapperInstanceId,
          payload: { recovery: recovery.wireRecovery(claimed.recovery), phase },
          deadlineAt,
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
        });
        await assertCurrent();
        if (!response.ok)
          throw new SandboxControlConnectionError('Recovery was not acknowledged', true);
        const acknowledgement = sandboxReconcileResultSchema.parse(response.result);
        if (
          acknowledgement.episodeId !== claimed.recovery.episodeId ||
          acknowledgement.attempt !== claimed.recovery.attempt ||
          acknowledgement.phase !== phase
        )
          throw new SandboxControlConnectionError('Recovery acknowledgement changed', false);
      };
      const finish = async () => {
        await persist(current => {
          if (!recovery.activationCommitted(current))
            throw new SandboxControlConnectionError('Recovery activation was not committed', true);
          if (!recovery.hasUnresolvedRoots(current.authority)) return undefined;
          return recovery.failAttempt(
            {
              ...current,
              activationAcknowledgedAt: current.activationAcknowledgedAt ?? Date.now(),
            },
            Date.now()
          );
        }, true);
        dependencies.onActivated(runtime.identity);
        return true;
      };
      await assertCurrent();
      if (repairingActivation) {
        await phase('commit');
        return await finish();
      }
      const authority = await dependencies.loadAuthority(claimed.recovery);
      if (!authority)
        throw new SandboxControlConnectionError('Recovery authority is unavailable', true);
      await persist(current => recovery.replaceRecoveryAuthority(current, authority));
      if (claimed.recovery.activationAcknowledgedAt === undefined) await phase('drain');
      const effectiveAuthority = claimed.recovery.authority;
      if (!effectiveAuthority)
        throw new SandboxControlConnectionError('Recovery authority is unavailable', true);
      const [stops, operations] = await Promise.all([
        dependencies.reconcileStops(effectiveAuthority),
        dependencies.reconcileOperations(effectiveAuthority),
      ]);
      await persist(current => ({
        ...current,
        authority: {
          ...effectiveAuthority,
          roots: effectiveAuthority.roots?.map(root => {
            const stop = stops.find(item => item.sessionId === root.sessionId)?.decision;
            const operation = operations.find(item => item.sessionId === root.sessionId)?.decision;
            const decision = stop === 'stop_pending' ? stop : (operation ?? 'operation_unknown');
            return {
              ...root,
              decision:
                root.observation === 'stale' || root.observation === 'unknown'
                  ? 'operation_unknown'
                  : decision,
            };
          }),
        },
      }));
      if (claimed.recovery.activationAcknowledgedAt !== undefined) return await finish();
      await phase('ready');
      const statusDeadlineAt = requestDeadlineAt();
      const status = await dependencies.sendRequest({
        operation: 'sandbox.status',
        payload: {},
        expectedWrapperInstanceId: runtime.identity.wrapperInstanceId,
        deadlineAt: statusDeadlineAt,
        timeoutMs: Math.max(1, statusDeadlineAt - Date.now()),
      });
      await assertCurrent();
      if (!status.ok || !sandboxStatusResultSchema.parse(status.result).kiloReady)
        throw new SandboxControlConnectionError('Recovered wrapper is not ready', true);
      if (!(await dependencies.onReady(runtime.identity, claimed.recovery)))
        throw new SandboxControlConnectionError('Recovery activation was not committed', true);
      await persist(current => {
        const acknowledgement = recovery.claimAttempt(current, runtime.identity, Date.now());
        if (!acknowledgement)
          throw new SandboxControlConnectionError('Activation acknowledgement expired', false);
        claimed = acknowledgement;
        return acknowledgement.recovery;
      });
      await assertCurrent();
      await phase('commit');
      return await finish();
    } catch {
      await persist(current => recovery.failAttempt(current, Date.now())).catch(() => undefined);
      return false;
    }
  }

  return {
    reconcile(runtime: RecoveryExecutionRuntime): Promise<boolean> {
      const key = [
        runtime.identity.providerInstanceId,
        runtime.identity.wrapperInstanceId,
        runtime.identity.connectionId,
      ].join(':');
      const existing = pending.get(key);
      if (existing) return existing;
      const running = reconcile(runtime).finally(() => {
        if (pending.get(key) === running) pending.delete(key);
      });
      pending.set(key, running);
      return running;
    },
  };
}
