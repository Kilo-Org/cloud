import { z } from 'zod';
import {
  cloudAgentWorktreeDeletionSchema,
  cloudAgentWorktreeLocationSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import type { AllocationState } from './allocation.js';

export const WORKTREE_DELETION_PREFIX = 'worktree_deletion/';

export const controlPlaneWorktreeDeletionInputSchema = cloudAgentWorktreeDeletionSchema
  .extend({ location: cloudAgentWorktreeLocationSchema, sessionIds: z.array(sessionIdSchema) })
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

export type WorktreeDeletionPlan = {
  action: 'replay' | 'complete' | 'stop';
  journal: WorktreeRuntimeDeletionJournal;
  allocationId: string | null;
  providerRef: string | null;
};

export async function beginWorktreeDeletion(input: {
  request: ControlPlaneWorktreeDeletionInput;
  storage: DurableObjectStorage;
  allocation: AllocationState;
}): Promise<WorktreeDeletionPlan> {
  const { request, storage, allocation } = input;
  const previous = await loadWorktreeDeletionJournal(storage, request.worktreeId);
  const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...request.sessionIds])];
  const scopedCleanupConfirmed =
    previous?.resourcesCleaned === true && previous.sessionIds.length === sessionIds.length;
  if (scopedCleanupConfirmed && previous.destroyed) {
    return {
      action: 'replay',
      journal: previous,
      allocationId: allocation.allocationId,
      providerRef: null,
    };
  }

  const journal: WorktreeRuntimeDeletionJournal = {
    sessionIds,
    resourcesCleaned: scopedCleanupConfirmed,
    destroyed: previous?.destroyed ?? false,
    completed: false,
    exclusiveTeardown: true,
  };
  await storage.put(`${WORKTREE_DELETION_PREFIX}${request.worktreeId}`, journal);

  // A stopped routing state can retain an unconfirmed physical allocation.
  const providerRef =
    allocation.kind === 'stopped' ? allocation.unconfirmedProviderRef : allocation.providerRef;
  return {
    action: allocation.kind === 'stopped' && providerRef === null ? 'complete' : 'stop',
    journal,
    allocationId: allocation.allocationId,
    providerRef,
  };
}

export async function finishWorktreeDeletion(
  storage: DurableObjectStorage,
  worktreeId: string,
  plan: WorktreeDeletionPlan
): Promise<WorktreeRuntimeDeletionJournal> {
  const journal: WorktreeRuntimeDeletionJournal = {
    ...plan.journal,
    resourcesCleaned: true,
    destroyed: true,
  };
  await storage.put(`${WORKTREE_DELETION_PREFIX}${worktreeId}`, journal);
  return journal;
}
