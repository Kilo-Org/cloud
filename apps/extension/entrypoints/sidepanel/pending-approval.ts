/* eslint-disable max-lines -- Request, persistence, and auto-approve share one lock and one settle contract. */
import { atom, getDefaultStore } from 'jotai';
import type { PendingAgentMemoryDraft } from '@/src/shared/agent-memories';
import { loadMemorySettings } from '@/src/shared/agent-memory-settings';
import type { AgentMemorySettingsStorageArea } from '@/src/shared/agent-memory-settings';
import {
  addAgentMemory,
  clearPendingAgentMemoryDraft,
  savePendingAgentMemoryDraft,
} from '@/src/shared/agent-memories-storage';
import type { AgentMemoriesStorageArea } from '@/src/shared/agent-memories-storage';
import type { AgentWorkflowInput, PendingAgentWorkflowDraft } from '@/src/shared/agent-workflows';
import { hashWorkflowScript } from '@/src/shared/agent-workflows';
import {
  addAgentWorkflow,
  clearPendingWorkflowDraft,
  loadWorkflowSettings,
  savePendingWorkflowDraft,
  updateAgentWorkflow,
} from '@/src/shared/agent-workflows-storage';
import type { AgentWorkflowsStorageArea } from '@/src/shared/agent-workflows-storage';

// ---------- types ----------

/* AutoApproved is true only for saves applied without a card, enabled by the
   per-kind auto-approve setting. Every card approval reports false. */
export type ApprovalOutcome =
  | { status: 'approved'; savedId: string; autoApproved: boolean }
  | { status: 'rejected' }
  | { status: 'aborted' }
  | { status: 'failed'; reason: string };

export type ApprovalKind = 'workflow' | 'memory';

export type ApprovalDraft = PendingAgentMemoryDraft | PendingAgentWorkflowDraft;

export type PendingApprovalEntry =
  | {
      draft: PendingAgentMemoryDraft;
      kind: 'memory';
      settle: (outcome: ApprovalOutcome) => void;
    }
  | {
      draft: PendingAgentWorkflowDraft;
      kind: 'workflow';
      settle: (outcome: ApprovalOutcome) => void;
    };

// ---------- atom ----------

export const pendingApprovalAtom = atom<PendingApprovalEntry | undefined>();

// Synchronous single-flight lock set before persisting, cleared on settle or persist failure.
const pendingLockAtom = atom<boolean>(false);
export { pendingLockAtom };

// ---------- shared storage type ----------

/* Unified storage area that satisfies the memory, memory-settings, and
   workflow storage contracts. */
type UnifiedStorage = AgentMemoriesStorageArea &
  AgentMemorySettingsStorageArea &
  AgentWorkflowsStorageArea;

// ---------- draft persistence helpers ----------

const isMemoryDraft = (
  draft: ApprovalDraft | Record<string, unknown>
): draft is PendingAgentMemoryDraft => 'text' in draft;

const isWorkflowDraft = (
  draft: ApprovalDraft | Record<string, unknown>
): draft is PendingAgentWorkflowDraft => 'script' in draft && 'scopeOrigin' in draft;

const persistDraft = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: ApprovalDraft | Record<string, unknown>
): Promise<void> => {
  if (kind === 'memory' && isMemoryDraft(draft)) {
    await savePendingAgentMemoryDraft(storage, draft);
    return;
  }
  if (kind === 'workflow' && isWorkflowDraft(draft)) {
    await savePendingWorkflowDraft(storage, draft);
    return;
  }
  throw new Error('Approval draft does not match its kind.');
};

const clearDraft = async (storage: UnifiedStorage, kind: ApprovalKind): Promise<void> => {
  if (kind === 'memory') {
    await clearPendingAgentMemoryDraft(storage);
    return;
  }
  await clearPendingWorkflowDraft(storage);
};

// ---------- public API ----------

/**
 * Persist a save decision.
 *
 * Approve: persist the record FIRST, then clear the stored draft, return approved
 * with autoApproved false (a card approval).
 * Persist failure (e.g. store full): KEEP the draft and return { status: 'failed', reason }.
 * Reject: clear the draft, return rejected.
 *
 * The caller disables its buttons while applying so persist-then-clear cannot double-fire.
 */
// eslint-disable-next-line max-params -- The public approval contract needs storage, kind, draft, and decision.
export const applyApprovalDecision = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: ApprovalDraft | Record<string, unknown>,
  approved: boolean
): Promise<ApprovalOutcome> => {
  if (!approved) {
    try {
      await clearDraft(storage, kind);
    } catch {
      // Draft could not be cleared — still report rejected so the caller does not throw.
    }
    return { status: 'rejected' };
  }

  if (kind === 'memory') {
    if (!isMemoryDraft(draft)) {
      return { reason: 'Approval draft does not match its kind.', status: 'failed' };
    }
    const memoryDraft = draft;
    const input = {
      createdAt: memoryDraft.createdAt,
      pageTitle: memoryDraft.pageTitle,
      pageUrl: memoryDraft.pageUrl,
      text: memoryDraft.text,
      ...(memoryDraft.truncated === undefined ? {} : { truncated: memoryDraft.truncated }),
      ...(memoryDraft.note !== undefined && memoryDraft.note.trim().length > 0
        ? { note: memoryDraft.note.trim() }
        : {}),
    };
    try {
      const saved = await addAgentMemory(storage, input);
      await clearPendingAgentMemoryDraft(storage);
      return { autoApproved: false, savedId: saved.id, status: 'approved' };
    } catch (error) {
      if (error instanceof Error && error.name === 'AgentMemoryStoreFullError') {
        return { reason: 'Memory store is full.', status: 'failed' };
      }
      return {
        reason: error instanceof Error ? error.message : 'Failed to save memory.',
        status: 'failed',
      };
    }
  }

  // Workflow persistence.
  if (!isWorkflowDraft(draft)) {
    return { reason: 'Approval draft does not match its kind.', status: 'failed' };
  }
  const workflowDraft = draft;
  const approvedScriptHash = await hashWorkflowScript(workflowDraft.script);
  const input: AgentWorkflowInput = {
    approvedScriptHash,
    description: workflowDraft.description,
    name: workflowDraft.name,
    scopeOrigin: workflowDraft.scopeOrigin,
    script: workflowDraft.script,
    // Empty string is the "cleared" sentinel (survives JSON, never a valid real value).
    // Map it to undefined so updateAgentWorkflow detects the key via Object.hasOwn
    // And removes the field from storage. Params use the empty array the same way.
    ...(workflowDraft.params === undefined
      ? {}
      : { params: workflowDraft.params.length === 0 ? undefined : workflowDraft.params }),
    ...(workflowDraft.pathPrefix === undefined || workflowDraft.pathPrefix === null
      ? {}
      : { pathPrefix: workflowDraft.pathPrefix === '' ? undefined : workflowDraft.pathPrefix }),
    ...(workflowDraft.startUrl === undefined || workflowDraft.startUrl === null
      ? {}
      : { startUrl: workflowDraft.startUrl === '' ? undefined : workflowDraft.startUrl }),
  };

  try {
    if (workflowDraft.workflowId !== undefined) {
      // Update existing workflow.
      const updated = await updateAgentWorkflow(storage, workflowDraft.workflowId, input);
      await clearPendingWorkflowDraft(storage);
      return { autoApproved: false, savedId: updated.id, status: 'approved' };
    }

    // Create new workflow.
    const saved = await addAgentWorkflow(storage, input);
    await clearPendingWorkflowDraft(storage);
    return { autoApproved: false, savedId: saved.id, status: 'approved' };
  } catch (error) {
    if (error instanceof Error && error.name === 'AgentWorkflowStoreFullError') {
      return { reason: 'Workflow store is full.', status: 'failed' };
    }
    return {
      reason: error instanceof Error ? error.message : 'Failed to save workflow.',
      status: 'failed',
    };
  }
};

/**
 * Request user approval for a save. Persists the draft to storage FIRST, then sets the atom,
 * and returns a Promise that settles exactly once (first-wins).
 *
 * Both kinds check their auto-approve setting before persisting the draft: a workflow
 * save reads autoApproveWorkflowChanges, a memory save reads autoApproveMemorySaves.
 * When the setting enables it, the save applies immediately without a card and returns
 * approved with autoApproved true. A failed settings read falls back to the approval
 * card (the cautious path, since auto-approve cannot be verified); a hash failure
 * returns failed.
 *
 * Single-flight: if another approval is already pending, returns failed immediately.
 * Persist failure: returns failed without setting the atom — the card never shows.
 *
 * On signal abort: clears the atom and the stored draft and settles aborted.
 * On settle: ALWAYS clears the atom entry.
 */
// eslint-disable-next-line max-params -- The public approval contract needs storage, kind, draft, and signal.
export const requestApproval = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: ApprovalDraft | Record<string, unknown>,
  signal: AbortSignal
): Promise<ApprovalOutcome> => {
  const atomStore = getDefaultStore();

  // Single-flight check using a synchronous lock.
  if (atomStore.get(pendingLockAtom)) {
    return { reason: 'Another approval is already pending.', status: 'failed' };
  }
  atomStore.set(pendingLockAtom, true);

  let autoApprove = false;
  try {
    if (kind === 'workflow') {
      const workflowSettings = await loadWorkflowSettings(storage);
      autoApprove = workflowSettings.autoApproveWorkflowChanges;
    } else {
      const memorySettings = await loadMemorySettings(storage);
      autoApprove = memorySettings.autoApproveMemorySaves;
    }
  } catch {
    // A failed settings read must not block the save.
    // Auto-approve cannot be verified, so fall through to the approval card.
    autoApprove = false;
  }

  if (autoApprove) {
    try {
      if (signal.aborted) {
        return { status: 'aborted' };
      }
      const outcome = await applyApprovalDecision(storage, kind, draft, true);
      if (outcome.status === 'approved') {
        return { autoApproved: true, savedId: outcome.savedId, status: 'approved' };
      }
      return outcome;
    } catch (error) {
      return {
        reason: error instanceof Error ? error.message : `Failed to save ${kind}.`,
        status: 'failed',
      };
    } finally {
      atomStore.set(pendingLockAtom, false);
    }
  }

  // Persist the draft FIRST. If persist fails, clear the lock and return failed.
  try {
    await persistDraft(storage, kind, draft);
  } catch (error) {
    atomStore.set(pendingLockAtom, false);
    return {
      reason: error instanceof Error ? error.message : 'Failed to persist draft.',
      status: 'failed',
    };
  }

  // eslint-disable-next-line promise/avoid-new -- intentional promise for first-wins abort handling
  return new Promise<ApprovalOutcome>(resolve => {
    let settled = false;

    const settle = (outcome: ApprovalOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      atomStore.set(pendingApprovalAtom, undefined);
      atomStore.set(pendingLockAtom, false);
      resolve(outcome);
    };

    if (signal.aborted) {
      settle({ status: 'aborted' });
      void clearDraft(storage, kind);
      return;
    }

    const onAbort = (): void => {
      settle({ status: 'aborted' });
      void clearDraft(storage, kind);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    // Set the atom entry synchronously so the card can render it.
    // Branch on kind so TypeScript can narrow the discriminated union.
    if (kind === 'memory' && isMemoryDraft(draft)) {
      const memoryDraft = draft;
      atomStore.set(pendingApprovalAtom, {
        draft: memoryDraft,
        kind: 'memory',
        settle: finalOutcome => {
          signal.removeEventListener('abort', onAbort);
          settle(finalOutcome);
        },
      });
    } else if (kind === 'workflow' && isWorkflowDraft(draft)) {
      const workflowDraft = draft;
      atomStore.set(pendingApprovalAtom, {
        draft: workflowDraft,
        kind: 'workflow',
        settle: finalOutcome => {
          signal.removeEventListener('abort', onAbort);
          settle(finalOutcome);
        },
      });
    } else {
      settle({ reason: 'Approval draft does not match its kind.', status: 'failed' });
    }
  });
};
