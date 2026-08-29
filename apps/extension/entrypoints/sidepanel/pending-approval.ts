/* eslint-disable max-lines -- Request, persistence, and auto-approve share one lock and one settle contract. */
import { atom, getDefaultStore } from 'jotai';
import {
  approvalOriginSchema,
  matchesDelegatedApproval,
  pendingAgentMemoryDraftSchema,
} from '@/src/shared/agent-memories';
import type {
  ApprovalOrigin,
  DelegatedApprovalOrigin,
  NormalizedPendingAgentMemoryDraft,
  PendingAgentMemoryDraft,
} from '@/src/shared/agent-memories';
import { loadMemorySettings } from '@/src/shared/agent-memory-settings';
import type { AgentMemorySettingsStorageArea } from '@/src/shared/agent-memory-settings';
import {
  addAgentMemory,
  clearPendingAgentMemoryDraft,
  savePendingAgentMemoryDraft,
} from '@/src/shared/agent-memories-storage';
import type { AgentMemoriesStorageArea } from '@/src/shared/agent-memories-storage';
import { ExecutionStoppedError, isExecutionStopped } from '@/src/shared/agent-tool-results';
import type { ExecutionGuard } from '@/src/shared/agent-tool-results';
import type {
  AgentWorkflowInput,
  NormalizedPendingAgentWorkflowDraft,
  PendingAgentWorkflowDraft,
} from '@/src/shared/agent-workflows';
import { hashWorkflowScript, pendingAgentWorkflowDraftSchema } from '@/src/shared/agent-workflows';
import {
  addAgentWorkflow,
  clearPendingWorkflowDraft,
  loadWorkflowSettings,
  savePendingWorkflowDraft,
  updateAgentWorkflow,
} from '@/src/shared/agent-workflows-storage';
import type { AgentWorkflowsStorageArea } from '@/src/shared/agent-workflows-storage';

/* AutoApproved is true only for saves applied without a card, enabled by the
   per-kind auto-approve setting. Every card approval reports false. */
export type ApprovalOutcome =
  | { status: 'approved'; savedId: string; autoApproved: boolean }
  | { status: 'rejected' }
  | { status: 'aborted' }
  | { status: 'failed'; reason: string };

export type ApprovalKind = 'workflow' | 'memory';
// Legacy producer inputs permit absent origin; current card consumers use normalized entries.
export type ApprovalDraft = PendingAgentMemoryDraft | PendingAgentWorkflowDraft;

/** Only the delegated caller supplies these checks, never model arguments or persisted data. */
export type DelegatedApprovalScope = Pick<DelegatedApprovalOrigin, 'invocationId' | 'expiresAt'> & {
  isLive: () => boolean;
  executionGuard: ExecutionGuard;
};

export type PendingApprovalEntry = (
  | { draft: NormalizedPendingAgentMemoryDraft; kind: 'memory' }
  | { draft: NormalizedPendingAgentWorkflowDraft; kind: 'workflow' }
) & {
  settle: (outcome: ApprovalOutcome) => void;
  isLive?: () => boolean;
};

export const pendingApprovalAtom = atom<PendingApprovalEntry | undefined>();
// Synchronous single-flight lock, including settings reads and draft persistence.
export const pendingLockAtom = atom<boolean>(false);
const decidedApprovals = new WeakSet<PendingApprovalEntry>();

type UnifiedStorage = AgentMemoriesStorageArea &
  AgentMemorySettingsStorageArea &
  AgentWorkflowsStorageArea;

export const approvalDraftKey = (draft: PendingApprovalEntry['draft']): string =>
  JSON.stringify([
    approvalOriginSchema.parse(draft.origin),
    draft.createdAt,
    'text' in draft ? draft.text : draft.script,
  ]);

const matchesApprovalEntry = (
  kind: ApprovalKind,
  draft: PendingApprovalEntry['draft'],
  entry: PendingApprovalEntry | undefined
): boolean => entry?.kind === kind && approvalDraftKey(entry.draft) === approvalDraftKey(draft);

const isOriginLive = (
  kind: ApprovalKind,
  origin: ApprovalOrigin,
  entry: PendingApprovalEntry | undefined
): boolean => {
  if (origin.kind === 'local') {
    // Old local draft records reload without a runner, including background-created memories.
    // Remove this branch only after all old local callers and stored drafts retire.
    return true;
  }
  return (
    Date.now() < origin.expiresAt &&
    entry?.kind === kind &&
    matchesDelegatedApproval(entry.draft.origin, origin) &&
    entry.isLive?.() === true
  );
};

export const isApprovalDraftLive = (
  kind: ApprovalKind,
  draft: PendingApprovalEntry['draft'],
  entry = getDefaultStore().get(pendingApprovalAtom)
): boolean => isOriginLive(kind, draft.origin, entry);

// eslint-disable-next-line max-params -- Both cards must settle only their own contextual entry.
export const settleMatchingApproval = (
  store: ReturnType<typeof getDefaultStore>,
  kind: ApprovalKind,
  draft: PendingApprovalEntry['draft'],
  outcome: ApprovalOutcome
): void => {
  const entry = store.get(pendingApprovalAtom);
  if (!entry || !matchesApprovalEntry(kind, draft, entry)) {
    return;
  }
  if (
    outcome.status === 'failed' &&
    entry.draft.origin.kind === 'delegated' &&
    isApprovalDraftLive(kind, draft, entry)
  ) {
    // Keep the runner waiting for explicit recovery while this delegated approval remains live.
    return;
  }
  entry.settle(outcome);
  if (store.get(pendingApprovalAtom) === entry) {
    store.set(pendingApprovalAtom, undefined);
  }
};

// eslint-disable-next-line max-params -- Preserve the local cleanup-failure contract without retracting delegated saves.
const clearDraft = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  origin: ApprovalOrigin,
  reportLocalFailure = false
): Promise<void> => {
  const expected = origin.kind === 'delegated' ? origin : undefined;
  try {
    await (kind === 'memory'
      ? clearPendingAgentMemoryDraft(storage, expected)
      : clearPendingWorkflowDraft(storage, expected));
  } catch (error) {
    // Old local approvals report cleanup failures. Remove this branch after those callers retire.
    if (reportLocalFailure && origin.kind === 'local') {
      throw error;
    }
    // A failed cleanup cannot undo an issued save. Tagged drafts still fail closed on reload.
  }
};

/** Hide and discard only the invalid delegated draft, never a replacement or a local selection. */
export const discardInactiveApprovalDraft = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: PendingApprovalEntry['draft']
): Promise<void> => {
  if (draft.origin.kind === 'delegated') {
    await clearDraft(storage, kind, draft.origin);
  }
};

// eslint-disable-next-line max-params -- The internal guard reaches the actual storage write after awaited preparation.
const persistApprovalDecision = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: ApprovalDraft | Record<string, unknown>,
  approved: boolean,
  executionGuard: ExecutionGuard | undefined
): Promise<ApprovalOutcome> => {
  const origin = approvalOriginSchema.parse(draft.origin);
  if (!approved) {
    await clearDraft(storage, kind, origin);
    return { status: 'rejected' };
  }

  if (kind === 'memory') {
    const parsed = pendingAgentMemoryDraftSchema.safeParse(draft);
    if (!parsed.success) {
      return { reason: 'Approval draft does not match its kind.', status: 'failed' };
    }
    const memoryDraft = parsed.data;
    const saved = await addAgentMemory(
      storage,
      {
        createdAt: memoryDraft.createdAt,
        pageTitle: memoryDraft.pageTitle,
        pageUrl: memoryDraft.pageUrl,
        text: memoryDraft.text,
        ...(memoryDraft.truncated === undefined ? {} : { truncated: memoryDraft.truncated }),
        ...(memoryDraft.note !== undefined && memoryDraft.note.trim().length > 0
          ? { note: memoryDraft.note.trim() }
          : {}),
      },
      executionGuard
    );
    await clearDraft(storage, kind, origin, true);
    return { autoApproved: false, savedId: saved.id, status: 'approved' };
  }

  const parsed = pendingAgentWorkflowDraftSchema.safeParse(draft);
  if (!parsed.success) {
    return { reason: 'Approval draft does not match its kind.', status: 'failed' };
  }
  const workflowDraft = parsed.data;
  const approvedScriptHash = await hashWorkflowScript(workflowDraft.script);
  const input: AgentWorkflowInput = {
    approvedScriptHash,
    description: workflowDraft.description,
    name: workflowDraft.name,
    scopeOrigin: workflowDraft.scopeOrigin,
    script: workflowDraft.script,
    // Empty string is the cleared sentinel. Preserve Object.hasOwn update semantics.
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
  const saved =
    workflowDraft.workflowId === undefined
      ? await addAgentWorkflow(storage, input, executionGuard)
      : await updateAgentWorkflow(storage, workflowDraft.workflowId, input, executionGuard);
  await clearDraft(storage, kind, origin, true);
  return { autoApproved: false, savedId: saved.id, status: 'approved' };
};

/** Recheck at decision and actual write, after hashing and storage reads have completed. */
// eslint-disable-next-line max-params -- Preserve local callers; cards can pass their contextual atom entry.
export const applyApprovalDecision = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  draft: ApprovalDraft | Record<string, unknown>,
  approved: boolean,
  entry = getDefaultStore().get(pendingApprovalAtom)
): Promise<ApprovalOutcome> => {
  const parsed = approvalOriginSchema.safeParse(draft.origin);
  if (!parsed.success) {
    return { status: 'aborted' };
  }
  const origin = parsed.data;
  const isLive = (): boolean => isOriginLive(kind, origin, entry);
  if (!isLive()) {
    await clearDraft(storage, kind, origin);
    return { status: 'aborted' };
  }
  if (origin.kind === 'delegated' && entry) {
    if (decidedApprovals.has(entry)) {
      return { status: 'aborted' };
    }
    decidedApprovals.add(entry);
  }
  const guard = (): void => {
    if (!isLive()) {
      throw new ExecutionStoppedError('Approval is no longer active.', 'cancelled');
    }
    // Stop prevents future writes; it cannot retract a write after issuance.
  };
  let outcome: ApprovalOutcome = { status: 'aborted' };
  try {
    outcome = await persistApprovalDecision(
      storage,
      kind,
      draft,
      approved,
      origin.kind === 'delegated' ? guard : undefined
    );
  } catch (error) {
    if (isExecutionStopped(error)) {
      await clearDraft(storage, kind, origin);
    } else {
      let reason = error instanceof Error ? error.message : `Failed to save ${kind}.`;
      if (error instanceof Error && error.name === 'AgentMemoryStoreFullError') {
        reason = 'Memory store is full.';
      } else if (error instanceof Error && error.name === 'AgentWorkflowStoreFullError') {
        reason = 'Workflow store is full.';
      }
      outcome = { reason, status: 'failed' };
    }
  }
  if (outcome.status === 'failed' && origin.kind === 'delegated' && entry) {
    decidedApprovals.delete(entry);
  }
  return outcome;
};

/**
 * Persist before displaying a card. Local callers retain settings-based auto-approval and reload.
 * Delegated callers supply live invocation checks and a deadline; neither is recovered from disk.
 * Settlement is first-wins. Aborting invalidates the entry before asynchronous cleanup completes.
 */
// eslint-disable-next-line max-params -- The optional delegated scope preserves the old signal-only call form.
export const requestApproval = async (
  storage: UnifiedStorage,
  kind: ApprovalKind,
  input: ApprovalDraft | Record<string, unknown>,
  signal: AbortSignal,
  invocation?: DelegatedApprovalScope
): Promise<ApprovalOutcome> => {
  const atomStore = getDefaultStore();
  if (atomStore.get(pendingLockAtom)) {
    return { reason: 'Another approval is already pending.', status: 'failed' };
  }
  atomStore.set(pendingLockAtom, true);

  // Old local requestApproval callers omit the invocation scope.
  // Remove this call form after all old local callers and stored drafts retire.
  const parsedOrigin = approvalOriginSchema.safeParse(
    invocation
      ? {
          approvalId: crypto.randomUUID(),
          expiresAt: invocation.expiresAt,
          invocationId: invocation.invocationId,
          kind: 'delegated',
        }
      : input.origin
  );
  if (!parsedOrigin.success) {
    atomStore.set(pendingLockAtom, false);
    return { status: 'aborted' };
  }
  const origin = parsedOrigin.data;
  const draft = { ...input, origin };
  let settled = false;
  let published = false;
  let entry: PendingApprovalEntry | undefined = undefined;
  const isLive = (): boolean => {
    try {
      if (
        settled ||
        signal.aborted ||
        (published && atomStore.get(pendingApprovalAtom) !== entry)
      ) {
        return false;
      }
      if (origin.kind === 'delegated') {
        if (!invocation || Date.now() >= origin.expiresAt || !invocation.isLive()) {
          return false;
        }
        invocation.executionGuard();
      }
      return true;
    } catch {
      return false;
    }
  };
  const guard = (): void => {
    if (!isLive()) {
      throw new ExecutionStoppedError('Approval is no longer active.', 'cancelled');
    }
  };

  try {
    let autoApprove = false;
    try {
      if (kind === 'workflow') {
        const settings = await loadWorkflowSettings(storage);
        autoApprove = settings.autoApproveWorkflowChanges;
      } else {
        const settings = await loadMemorySettings(storage);
        autoApprove = settings.autoApproveMemorySaves;
      }
    } catch {
      // A failed settings read cannot grant auto-approval. Show the existing card instead.
    }
    if (!isLive()) {
      if (origin.kind === 'delegated') {
        await clearDraft(storage, kind, origin);
      }
      return { status: 'aborted' };
    }

    const memory = kind === 'memory' ? pendingAgentMemoryDraftSchema.safeParse(draft) : undefined;
    const workflow =
      kind === 'workflow' ? pendingAgentWorkflowDraftSchema.safeParse(draft) : undefined;
    const pending = Promise.withResolvers<ApprovalOutcome>();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    const settle = (outcome: ApprovalOutcome): void => {
      if (settled) {
        return;
      }
      const finalOutcome: ApprovalOutcome =
        origin.kind === 'delegated' && !isLive() ? { status: 'aborted' } : outcome;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      clearTimeout(expiryTimer);
      if (origin.kind === 'delegated' && finalOutcome.status !== 'approved') {
        void clearDraft(storage, kind, origin);
      }
      if (atomStore.get(pendingApprovalAtom) === entry) {
        atomStore.set(pendingApprovalAtom, undefined);
      }
      pending.resolve(finalOutcome);
    };
    const onAbort = (): void => {
      if (origin.kind === 'local') {
        void clearDraft(storage, kind, origin);
      }
      settle({ status: 'aborted' });
    };
    if (memory?.success === true) {
      entry = { draft: memory.data, isLive, kind: 'memory', settle };
    } else if (workflow?.success === true) {
      entry = { draft: workflow.data, isLive, kind: 'workflow', settle };
    } else {
      return { reason: 'Approval draft does not match its kind.', status: 'failed' };
    }

    if (autoApprove) {
      const outcome = await applyApprovalDecision(storage, kind, entry.draft, true, entry);
      return outcome.status === 'approved' ? { ...outcome, autoApproved: true } : outcome;
    }

    await (entry.kind === 'memory'
      ? savePendingAgentMemoryDraft(storage, entry.draft, guard)
      : savePendingWorkflowDraft(storage, entry.draft, guard));
    if (!isLive()) {
      await clearDraft(storage, kind, origin);
      return { status: 'aborted' };
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (origin.kind === 'delegated') {
      expiryTimer = setTimeout(onAbort, Math.min(origin.expiresAt - Date.now(), 2_147_483_647));
    }
    published = true;
    atomStore.set(pendingApprovalAtom, entry);
    return await pending.promise;
  } catch (error) {
    if (isExecutionStopped(error)) {
      await clearDraft(storage, kind, origin);
      return { status: 'aborted' };
    }
    return {
      reason: error instanceof Error ? error.message : 'Failed to persist draft.',
      status: 'failed',
    };
  } finally {
    settled = true;
    // A retained callback must not release another request's entry or lock.
    if (!published || atomStore.get(pendingApprovalAtom) === undefined) {
      atomStore.set(pendingLockAtom, false);
    }
  }
};
