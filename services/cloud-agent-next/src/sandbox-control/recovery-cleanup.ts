import * as recovery from './control-recovery.js';
import {
  loadDeadlines,
  loadNativeRuntimeRetirements,
  loadPhysicalRecord,
  loadRecoveryDecisions,
  loadRouteTable,
  saveDeadlines,
  saveNativeRuntimeRetirements,
  saveRecoveryDecisions,
  saveRouteTable,
  type NativeRuntimeRetirementReceipt,
} from './durable-state.js';
import { DEADLINE_MS, type DeadlineTable } from './deadlines.js';
import {
  sameNativeRuntimeRetirementLifetime,
  type NativeRuntimeRetirementConnection,
  type NativeRuntimeRetirementWorkflow,
} from './native-runtime-retirement.js';
import { beginStop, type PhysicalRecord } from './physical-lifecycle.js';
import type { SessionRoute } from './session-routes.js';

export const RECOVERY_CLEANUP_REASON = 'Control recovery exhausted';

type CleanupRoot = {
  sessionId: string;
  ownerId?: string;
  kiloSessionId: string;
  directory: string;
  nativeRuntimeId?: string;
};

type CleanupStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'transaction'>;
type CleanupState = NonNullable<recovery.SandboxRecoveryDecision['cleanupState']>;

export function selectRecoveryCleanupRoots(
  authority: recovery.RecoveryAuthority,
  now: number
): CleanupRoot[] {
  if (authority.roots !== undefined) {
    return authority.roots.filter(root => {
      if (root.decision === 'ready') return false;
      const expiredOperation = authority.scopes.some(
        scope =>
          scope.sessionId === root.sessionId &&
          scope.kiloSessionId === root.kiloSessionId &&
          scope.directory === root.directory &&
          scope.nativeRuntimeId === root.nativeRuntimeId &&
          scope.executionDeadlineAt !== undefined &&
          scope.executionDeadlineAt <= now
      );
      return (
        expiredOperation ||
        ((root.observation === 'known' || root.observation === 'idle') &&
          (root.decision === 'stop_pending' || root.decision === 'execution_expired'))
      );
    });
  }
  return authority.scopes.filter(
    scope =>
      (scope.executionDeadlineAt !== undefined && scope.executionDeadlineAt <= now) ||
      authority.stops.some(stop => stop.sessionId === scope.sessionId)
  );
}

function matchesRoot(route: CleanupRoot, root: CleanupRoot): boolean {
  return (
    route.sessionId === root.sessionId &&
    (root.ownerId === undefined || route.ownerId === root.ownerId) &&
    route.kiloSessionId === root.kiloSessionId &&
    route.directory === root.directory &&
    route.nativeRuntimeId === root.nativeRuntimeId
  );
}

function matchesAllocation(
  decision: recovery.SandboxRecoveryDecision,
  physical: PhysicalRecord
): boolean {
  return (
    decision.authority !== undefined &&
    decision.authority.allocation.providerRef === decision.providerInstanceId &&
    physical.providerRef === decision.providerInstanceId &&
    physical.createIntent?.intentId === decision.authority.allocation.createIntentId
  );
}

function provesRetirement(
  receipt: NativeRuntimeRetirementReceipt,
  decision: recovery.SandboxRecoveryDecision,
  root: CleanupRoot
): boolean {
  return (
    root.nativeRuntimeId !== undefined &&
    receipt.state === 'completed' &&
    receipt.disposition === 'retired' &&
    receipt.allocation.providerRef === decision.authority?.allocation.providerRef &&
    receipt.allocation.createIntentId === decision.authority?.allocation.createIntentId &&
    sameNativeRuntimeRetirementLifetime(receipt, {
      directory: root.directory,
      nativeRuntimeId: root.nativeRuntimeId,
      connection: decision,
    }) &&
    receipt.recipients.some(recipient => matchesRoot(recipient, root))
  );
}

export function ownsRecoveryCleanupAllocation(
  decision: recovery.SandboxRecoveryDecision,
  physical: PhysicalRecord,
  routes: Map<string, SessionRoute>,
  now: number
): boolean {
  const authority: recovery.RecoveryAuthority | undefined = decision.authority;
  if (!authority?.wholeAllocation || !matchesAllocation(decision, physical)) return false;
  const roots = selectRecoveryCleanupRoots(authority, now);
  return (
    roots.length > 0 &&
    authority.roots?.length === roots.length &&
    authority.roots.every(root => root.observation === 'known' || root.observation === 'idle') &&
    routes.size > 0 &&
    roots.every(root => {
      const route = routes.get(root.sessionId);
      return route !== undefined && matchesRoot(route, root);
    }) &&
    [...routes.values()].every(route =>
      roots.some(root => root.ownerId === route.ownerId && matchesRoot(route, root))
    )
  );
}

export function canRecoveryRetirementStopAllocation(
  receipt: NativeRuntimeRetirementReceipt,
  decisions: recovery.SandboxRecoveryDecision[],
  physical: PhysicalRecord,
  routes: Map<string, SessionRoute>,
  now: number
): boolean {
  return decisions.some(
    decision =>
      decision.exhaustedAt !== undefined &&
      decision.cleanupState !== 'completed' &&
      decision.cleanupState !== 'unconfirmed' &&
      decision.cleanupDeadlineAt !== undefined &&
      decision.cleanupDeadlineAt <= now &&
      receipt.cleanupDeadlineAt === decision.cleanupDeadlineAt &&
      receipt.allocation.createIntentId === decision.authority?.allocation.createIntentId &&
      receipt.allocation.providerRef === decision.providerInstanceId &&
      receipt.connection.wrapperInstanceId === decision.wrapperInstanceId &&
      ownsRecoveryCleanupAllocation(decision, physical, routes, now)
  );
}

export function createRecoveryCleanup(input: {
  storage: CleanupStorage;
  retirement: Pick<NativeRuntimeRetirementWorkflow, 'retire'>;
  getConnection: () => NativeRuntimeRetirementConnection | undefined;
  supportsTargetedRetirement: () => boolean;
  persistPhysical: (from: PhysicalRecord, to: PhysicalRecord, reason: string) => Promise<void>;
  onPhysicalStop: (from: PhysicalRecord, to: PhysicalRecord, reason: string) => Promise<void>;
  scheduleAlarm: (deadlines: DeadlineTable) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;

  const save = async (
    tx: DurableObjectTransaction,
    decisions: recovery.SandboxRecoveryDecision[]
  ): Promise<void> => {
    const deadlines = recovery.recoveryDeadlines(await loadDeadlines(tx), decisions, now());
    await saveRecoveryDecisions(tx, decisions);
    await saveDeadlines(tx, deadlines);
    await input.scheduleAlarm(deadlines);
  };

  const update = async (
    episodeId: string,
    state: CleanupState,
    nextAttemptAt?: number
  ): Promise<void> => {
    await input.storage.transaction(async tx => {
      const decisions = await loadRecoveryDecisions(tx);
      const current = decisions.find(item => item.episodeId === episodeId);
      if (!current || current.exhaustedAt === undefined) return;
      await save(
        tx,
        decisions.map(item =>
          item === current ? recovery.updateRecoveryCleanup(item, state, nextAttemptAt) : item
        )
      );
    });
  };

  const complete = async (episodeId: string): Promise<boolean> => {
    return input.storage.transaction(async tx => {
      const [decisions, physical, receipts, routes] = await Promise.all([
        loadRecoveryDecisions(tx),
        loadPhysicalRecord(tx),
        loadNativeRuntimeRetirements(tx),
        loadRouteTable(tx),
      ]);
      const current = decisions.find(item => item.episodeId === episodeId);
      if (!current || current.exhaustedAt === undefined) return false;
      if (!matchesAllocation(current, physical)) return false;
      if (physical.state === 'stopped') {
        await save(
          tx,
          decisions.filter(item => item !== current)
        );
        return true;
      }
      const authority = current.authority;
      if (!authority) return false;
      const roots = authority.roots?.filter(root => root.decision !== 'ready') ?? authority.scopes;
      const proven = roots.filter(root =>
        receipts.some(receipt => provesRetirement(receipt, current, root))
      );
      if (proven.length === 0) return false;
      for (const root of proven) {
        const route = routes.get(root.sessionId);
        if (
          !route ||
          !matchesRoot(route, root) ||
          (route.retiringNativeRuntimeId !== undefined &&
            route.retiringNativeRuntimeId !== root.nativeRuntimeId)
        )
          continue;
        const proof = receipts.find(receipt => provesRetirement(receipt, current, root));
        if (
          !proof?.recipients.some(
            recipient => matchesRoot(recipient, route) && recipient.worktreeId === route.worktreeId
          )
        )
          continue;
        const next = { ...route };
        delete next.retiringNativeRuntimeId;
        delete next.nativeRuntimeId;
        routes.set(route.sessionId, next);
      }
      await saveRouteTable(tx, routes);
      const nextAuthority: recovery.RecoveryAuthority = {
        ...authority,
        ...(authority.roots
          ? {
              roots: authority.roots.map(root =>
                proven.some(target => matchesRoot(root, target))
                  ? { ...root, observation: 'idle' as const, decision: 'ready' as const }
                  : root
              ),
            }
          : {}),
      };
      const finished = nextAuthority.roots
        ? nextAuthority.roots.every(
            root =>
              root.decision === 'ready' &&
              (root.observation === 'known' || root.observation === 'idle')
          ) &&
          [...routes.values()].every(route =>
            nextAuthority.roots?.some(
              root =>
                root.sessionId === route.sessionId &&
                root.ownerId === route.ownerId &&
                root.kiloSessionId === route.kiloSessionId &&
                root.directory === route.directory
            )
          )
        : authority.wholeAllocation && authority.scopes.length === proven.length;
      const settled = selectRecoveryCleanupRoots(nextAuthority, now()).length === 0;
      await save(
        tx,
        finished
          ? decisions.filter(item => item !== current)
          : decisions.map(item =>
              item === current
                ? {
                    ...recovery.updateRecoveryCleanup(
                      current,
                      settled ? 'unconfirmed' : 'targeted',
                      settled ? undefined : current.cleanupDeadlineAt
                    ),
                    authority: nextAuthority,
                  }
                : item
            )
      );
      return finished || settled;
    });
  };

  const beginPhysicalFallback = async (episodeId: string): Promise<void> => {
    const committed = await input.storage.transaction(async tx => {
      const [physical, decisions, routes, receipts] = await Promise.all([
        loadPhysicalRecord(tx),
        loadRecoveryDecisions(tx),
        loadRouteTable(tx),
        loadNativeRuntimeRetirements(tx),
      ]);
      const current = decisions.find(item => item.episodeId === episodeId);
      if (!current || current.exhaustedAt === undefined) return undefined;
      const connection = input.getConnection();
      const canStop =
        (!connection || recovery.sameRuntime(connection, current)) &&
        current.cleanupState !== 'unconfirmed' &&
        current.cleanupState !== 'completed' &&
        current.cleanupDeadlineAt !== undefined &&
        now() >= current.cleanupDeadlineAt &&
        ownsRecoveryCleanupAllocation(current, physical, routes, now());
      const stopping = matchesAllocation(current, physical) && physical.stopTombstone !== null;
      const next =
        canStop && physical.state === 'running' && !physical.stopTombstone
          ? beginStop(physical, RECOVERY_CLEANUP_REASON, now(), current.wrapperInstanceId)
          : undefined;
      if (next) await input.persistPhysical(physical, next, RECOVERY_CLEANUP_REASON);
      const state = next || stopping ? 'physical_fallback' : 'unconfirmed';
      if (state === 'unconfirmed') {
        await saveNativeRuntimeRetirements(
          tx,
          receipts.map(receipt =>
            receipt.reason === RECOVERY_CLEANUP_REASON &&
            receipt.state === 'pending' &&
            receipt.connection.wrapperInstanceId === current.wrapperInstanceId &&
            receipt.allocation.providerRef === current.providerInstanceId &&
            receipt.allocation.createIntentId === current.authority?.allocation.createIntentId
              ? { ...receipt, state: 'unconfirmed', nextAttemptAt: undefined }
              : receipt
          )
        );
      }
      await save(
        tx,
        decisions.map(item =>
          item === current
            ? recovery.updateRecoveryCleanup(
                item,
                state,
                state === 'physical_fallback' ? now() + DEADLINE_MS.reconciliation : undefined
              )
            : item
        )
      );
      return next ? { physical, next } : undefined;
    });
    if (committed)
      await input.onPhysicalStop(committed.physical, committed.next, RECOVERY_CLEANUP_REASON);
  };

  const retireRoot = async (episodeId: string, root: CleanupRoot): Promise<void> => {
    const target = await input.storage.transaction(async tx => {
      const [decisions, physical, routes] = await Promise.all([
        loadRecoveryDecisions(tx),
        loadPhysicalRecord(tx),
        loadRouteTable(tx),
      ]);
      const current = decisions.find(item => item.episodeId === episodeId);
      const connection = input.getConnection();
      const route = routes.get(root.sessionId);
      if (
        !current?.authority ||
        current.exhaustedAt === undefined ||
        current.cleanupState === 'completed' ||
        current.cleanupState === 'unconfirmed' ||
        current.cleanupDeadlineAt === undefined ||
        now() >= current.cleanupDeadlineAt ||
        !connection ||
        !recovery.sameRuntime(connection, current) ||
        !matchesAllocation(current, physical) ||
        physical.state !== 'running' ||
        physical.stopTombstone ||
        !root.nativeRuntimeId ||
        !route ||
        !matchesRoot(route, root)
      )
        return undefined;
      const roots = selectRecoveryCleanupRoots(current.authority, now());
      if (
        !roots.some(target => matchesRoot(target, root)) ||
        current.authority.roots?.some(
          sibling =>
            sibling.directory === root.directory &&
            !roots.some(target => matchesRoot(sibling, target))
        ) ||
        [...routes.values()].some(
          sibling =>
            sibling.directory === root.directory &&
            !roots.some(target => matchesRoot(sibling, target))
        )
      )
        return undefined;
      return {
        connection,
        physical,
        route,
        reason: RECOVERY_CLEANUP_REASON,
        cleanupDeadlineAt: current.cleanupDeadlineAt,
      };
    });
    if (target) await input.retirement.retire(target);
  };

  const reconcile = async (): Promise<void> => {
    const decisions = await loadRecoveryDecisions(input.storage);
    for (const decision of decisions) {
      if (decision.exhaustedAt === undefined || decision.cleanupState === 'completed') continue;
      if (await complete(decision.episodeId)) continue;
      if (decision.cleanupState === 'unconfirmed') continue;
      const physical = await loadPhysicalRecord(input.storage);
      const authority = decision.authority;
      if (!authority || !matchesAllocation(decision, physical)) {
        await update(decision.episodeId, 'unconfirmed');
        continue;
      }
      if (physical.stopTombstone) {
        await update(decision.episodeId, 'physical_fallback', now() + DEADLINE_MS.reconciliation);
        continue;
      }
      const roots = selectRecoveryCleanupRoots(authority, now());
      const connection = input.getConnection();
      const cleanupDeadlineAt = decision.cleanupDeadlineAt;
      if (cleanupDeadlineAt === undefined || roots.length === 0) {
        await update(decision.episodeId, 'unconfirmed');
        continue;
      }
      if (
        connection &&
        recovery.sameRuntime(connection, decision) &&
        input.supportsTargetedRetirement() &&
        now() < cleanupDeadlineAt
      ) {
        const attempted = new Set<string>();
        for (const root of roots) {
          const key = JSON.stringify([root.directory, root.nativeRuntimeId]);
          if (attempted.has(key)) continue;
          attempted.add(key);
          try {
            await retireRoot(decision.episodeId, root);
          } catch {
            continue;
          }
        }
      }
      if (await complete(decision.episodeId)) continue;
      if (now() < cleanupDeadlineAt) {
        await update(decision.episodeId, 'targeted', cleanupDeadlineAt);
      } else {
        await beginPhysicalFallback(decision.episodeId);
      }
    }
  };

  return {
    async exhaustExpired(at: number): Promise<void> {
      await input.storage.transaction(async tx => {
        const decisions = await loadRecoveryDecisions(tx);
        const next = decisions.map(item =>
          item.exhaustedAt === undefined &&
          (recovery.activationRepairPending(item)
            ? (item.activationCommitDeadlineAt ?? 0) <= at
            : item.deadlineAt <= at)
            ? recovery.exhaustRecovery(item, at)
            : item
        );
        if (next.some((item, index) => item !== decisions[index])) await save(tx, next);
      });
    },
    reconcile,
  };
}
