/**
 * B10 port of the legacy worktree-runtime cleanup onto the V2 Sandbox DO
 * (spec §6 "Billing, credentials and deletion", Shared Worktrees rule 13).
 *
 * The journal, the completion semantics and the "incomplete stays retryable"
 * contract are unchanged from the legacy DO. The decision is split in two so
 * the DO can run the bounded provider call OUTSIDE its serial queue:
 *
 * - `beginWorktreeDeletion` runs under the queue: it reads the allocation and
 *   routes, persists the initial journal, and returns what to do next.
 * - the caller then stops or observes the provider (bounded, off-queue).
 * - `finishWorktreeDeletion` runs under the queue again: it records the
 *   confirmed cleanup.
 *
 * `stopped` is a routing state and never proves a physical stop (spec §6/§9):
 * a `stopped` state may carry an `unconfirmedProviderRef` from an exhausted
 * stop ladder, in which case the physical stop must still be confirmed.
 *
 * A shared sandbox with a connected wrapper does not fail closed: `shared` tells
 * the caller to run the wrapper's `worktree.prepareDeletion`/`worktree.delete`
 * operations (R2), which clean up the worktree's checkout in place.
 */
import { z } from 'zod';
import {
  canDestroyCloudAgentWorktreeSandboxSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import type { AllocationState } from './allocation.js';
import type { RouteRecord } from './routes.js';

export const WORKTREE_DELETION_PREFIX = 'worktree_deletion/';

export const controlPlaneWorktreeDeletionInputSchema = canDestroyCloudAgentWorktreeSandboxSchema
  .extend({ sessionIds: z.array(sessionIdSchema) })
  .strict();
export type ControlPlaneWorktreeDeletionInput = z.infer<
  typeof controlPlaneWorktreeDeletionInputSchema
>;

const journalSchema = z
  .object({
    sessionIds: z.array(sessionIdSchema),
    resourcesCleaned: z.boolean(),
    destroyed: z.boolean(),
    completed: z.boolean().default(false),
    exclusiveTeardown: z.boolean().default(false),
  })
  .strict();
export type WorktreeRuntimeDeletionJournal = z.infer<typeof journalSchema>;

/** The provider did not confirm the stop or cleanup; the caller must retry. */
export class WorktreeDeletionIncompleteError extends Error {
  readonly retryable = true;
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeDeletionIncompleteError';
  }
}

export async function loadWorktreeDeletionJournal(
  storage: DurableObjectStorage,
  worktreeId: string
): Promise<WorktreeRuntimeDeletionJournal | undefined> {
  return journalSchema
    .optional()
    .parse(await storage.get(`${WORKTREE_DELETION_PREFIX}${worktreeId}`));
}

/**
 * The routes owned by the deleted worktree: the credential scope names it, or a
 * listed Kilo session is attached to it.
 */
export function worktreeOwnedRoutes(
  routes: readonly RouteRecord[],
  request: Pick<ControlPlaneWorktreeDeletionInput, 'worktreeId' | 'sessionIds'>
): RouteRecord[] {
  const sessionIds = new Set(request.sessionIds);
  return routes.filter(
    route =>
      (route.credentialSource?.scopeId ?? route.spec.sessionId) === request.worktreeId ||
      sessionIds.has(route.spec.kiloSessionId)
  );
}

function journalKey(worktreeId: string): string {
  return `${WORKTREE_DELETION_PREFIX}${worktreeId}`;
}

/** What the queue-free provider phase must do, or the terminal result. */
export type WorktreeDeletionAction = 'replay' | 'complete' | 'stop' | 'observe' | 'shared';

export type WorktreeDeletionPlan = {
  action: WorktreeDeletionAction;
  journal: WorktreeRuntimeDeletionJournal;
  /** True when the deleted worktree owns the sandbox's only routes. */
  exclusive: boolean;
  /** Allocation identity at planning time; a changed id fences the stop event. */
  allocationId: string | null;
  /** The ref to stop for `action: 'stop'`. */
  providerRef: string | null;
};

export type WorktreeDeletionBeginInput = {
  request: ControlPlaneWorktreeDeletionInput;
  exclusive: boolean;
  storage: DurableObjectStorage;
  allocation: AllocationState;
  hasConnection: boolean;
};

export async function beginWorktreeDeletion(
  input: WorktreeDeletionBeginInput
): Promise<WorktreeDeletionPlan> {
  const { request, exclusive, storage, allocation, hasConnection } = input;
  const previous = await loadWorktreeDeletionJournal(storage, request.worktreeId);
  const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...request.sessionIds])];
  const scopedCleanupConfirmed =
    previous?.resourcesCleaned === true && previous.sessionIds.length === sessionIds.length;
  if (scopedCleanupConfirmed && (!exclusive || previous.destroyed)) {
    return {
      action: 'replay',
      journal: previous,
      exclusive,
      allocationId: allocation.allocationId,
      providerRef: null,
    };
  }

  const journal: WorktreeRuntimeDeletionJournal = {
    sessionIds,
    resourcesCleaned: scopedCleanupConfirmed,
    destroyed: previous?.destroyed ?? false,
    completed: false,
    exclusiveTeardown: exclusive || (previous?.exclusiveTeardown ?? false),
  };
  await storage.put(journalKey(request.worktreeId), journal);

  if (allocation.kind === 'stopped') {
    // FIX 1: `stopped` alone is not proof. Only a null unconfirmed ref means the
    // provider confirmed the stop (or never started); otherwise keep the ref and
    // require a fresh confirmation before reporting success.
    if (allocation.unconfirmedProviderRef === null) {
      return {
        action: 'complete',
        journal,
        exclusive,
        allocationId: allocation.allocationId,
        providerRef: null,
      };
    }
    return {
      action: 'stop',
      journal,
      exclusive,
      allocationId: allocation.allocationId,
      providerRef: allocation.unconfirmedProviderRef,
    };
  }
  if (exclusive) {
    return {
      action: 'stop',
      journal,
      exclusive,
      allocationId: allocation.allocationId,
      providerRef: allocation.providerRef,
    };
  }
  if (hasConnection) {
    // R2: a shared worktree with a live wrapper is cleaned up in place by the
    // wrapper's delete-worktree operation (spec §6 "Billing..."). The caller
    // derives the checkout directory from the request, so this never fails
    // closed for a missing route.
    return {
      action: 'shared',
      journal,
      exclusive,
      allocationId: allocation.allocationId,
      providerRef: null,
    };
  }
  return {
    action: 'observe',
    journal,
    exclusive,
    allocationId: allocation.allocationId,
    providerRef: allocation.providerRef,
  };
}

/**
 * Records a confirmed cleanup after the caller has revoked the target routes.
 * `destroyed` marks the sandbox as exclusively destroyed for this worktree.
 * `confirmedSessionIds` extends the journal with the Kilo sessions the wrapper
 * discovered and deleted (R2), so the recorded manifest is complete.
 */
export async function finishWorktreeDeletion(
  storage: DurableObjectStorage,
  worktreeId: string,
  plan: WorktreeDeletionPlan,
  confirmedSessionIds?: readonly string[]
): Promise<WorktreeRuntimeDeletionJournal> {
  const journal: WorktreeRuntimeDeletionJournal = {
    ...plan.journal,
    ...(confirmedSessionIds === undefined
      ? {}
      : { sessionIds: [...new Set([...plan.journal.sessionIds, ...confirmedSessionIds])] }),
    // FIX 2: a terminal allocation can still hold stale routes/grants; the
    // caller has revoked them by the time this runs.
    resourcesCleaned: true,
    destroyed: plan.exclusive,
  };
  await storage.put(journalKey(worktreeId), journal);
  return journal;
}

/**
 * Persists the session manifest the wrapper discovered during
 * `worktree.prepareDeletion`, before the delete frame runs (legacy
 * `sandbox-control/worktree-deletion.ts` parity): a delete that removes a child
 * and then fails must not lose that child on retry. Reuses the existing journal.
 */
export async function persistWorktreeDeletionManifest(
  storage: DurableObjectStorage,
  worktreeId: string,
  journal: WorktreeRuntimeDeletionJournal,
  sessionIds: readonly string[]
): Promise<WorktreeRuntimeDeletionJournal> {
  const next: WorktreeRuntimeDeletionJournal = {
    ...journal,
    sessionIds: [...new Set([...journal.sessionIds, ...sessionIds])],
  };
  await storage.put(journalKey(worktreeId), next);
  return next;
}
