import { z } from 'zod';
import { withTimeout } from '@kilocode/worker-utils';
import {
  canDestroyCloudAgentWorktreeSandboxSchema,
  cloudAgentWorktreeIdSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import type { ProviderAdapter, ProviderAllocationIntent } from './provider';
import { loadRouteTable } from './durable-state';
import { loadAllocation as loadAllocationResult } from '../sandbox-state/persist/load.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import { DEADLINE_MS } from './deadlines';
import { logControlDiagnostic } from './diagnostics';
import type { SandboxControlOutboundRequest } from './socket';
import {
  worktreeDeleteResultSchema,
  worktreePrepareDeletionResultSchema,
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol';

export const WORKTREE_DELETION_PREFIX = 'worktree_deletion/';
export const EXCLUSIVE_DELETION_KEY = 'exclusive_worktree_deletion';
export const RUNTIME_DELETED_KEY = 'runtime_deleted';

export const sandboxWorktreeCleanupInputSchema = canDestroyCloudAgentWorktreeSandboxSchema
  .extend({
    sessionIds: z.array(sessionIdSchema),
  })
  .strict();
export type SandboxWorktreeCleanupInput = z.infer<typeof sandboxWorktreeCleanupInputSchema>;

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

export async function isUnallocatedControlRuntime(
  storage: DurableObjectStorage,
  hasConnection: () => boolean
): Promise<boolean> {
  const record = await loadAllocationRecord(storage);
  return isUnallocated(record) && (await loadRouteTable(storage)).size === 0 && !hasConnection();
}

/** A terminal record with no bound reference is an unallocated runtime. */
function isUnallocated(record: AllocationRecord): boolean {
  const state = record.state;
  return state.kind === 'stopped' && (state.summary?.providerRef ?? null) === null;
}

/** Canonical allocation read for the live path; never reads the removed flat key. */
async function loadAllocationRecord(storage: DurableObjectStorage): Promise<AllocationRecord> {
  const loaded = await loadAllocationResult(storage);
  if (!loaded.ok) throw new Error(`Sandbox allocation is unavailable (${loaded.reason})`);
  return loaded.value;
}

function providerRefOf(record: AllocationRecord): string | null {
  const state = record.state;
  if (state.kind === 'stopped') return state.summary?.providerRef ?? null;
  return state.target?.providerRef ?? null;
}

/** The provider intent for an outstanding create, rebuilt from canonical state. */
function providerIntentOf(record: AllocationRecord): ProviderAllocationIntent | null {
  const state = record.state;
  if (state.kind === 'stopped' || state.createIntent === null || state.target === null) return null;
  return {
    intentId: state.createIntent.intentId,
    createdAt: state.createIntent.createdAt,
    ...(state.target.allocationName === undefined
      ? {}
      : { allocationName: state.target.allocationName }),
    ...(state.target.vercel === undefined ? {} : { vercel: state.target.vercel }),
    ...(state.target.containment === undefined ? {} : { containment: state.target.containment }),
  };
}

/** Same canonical allocation: the create intent id, else the provider reference. */
function sameAllocationIdentity(left: AllocationRecord, right: AllocationRecord): boolean {
  const identity = (record: AllocationRecord) =>
    (record.state.kind === 'stopped' ? null : record.state.createIntent?.intentId) ??
    providerRefOf(record);
  const leftId = identity(left);
  return leftId !== null && leftId === identity(right);
}

export async function loadWorktreeDeletionJournal(
  storage: DurableObjectStorage,
  worktreeId: string
) {
  return journalSchema
    .optional()
    .parse(await storage.get(`${WORKTREE_DELETION_PREFIX}${worktreeId}`));
}

export async function loadWorktreeDeletionJournals(storage: DurableObjectStorage) {
  const rows = await storage.list({ prefix: WORKTREE_DELETION_PREFIX });
  return new Map(
    [...rows].map(
      ([key, value]) =>
        [
          cloudAgentWorktreeIdSchema.parse(key.slice(WORKTREE_DELETION_PREFIX.length)),
          journalSchema.parse(value),
        ] as const
    )
  );
}

export async function cleanWorktreeRuntime(input: {
  request: SandboxWorktreeCleanupInput;
  directory: string;
  storage: DurableObjectStorage;
  getProvider: () => Promise<ProviderAdapter>;
  stopRuntime: () => Promise<AllocationRecord>;
  hasConnection: () => boolean;
  sendRequest: (request: SandboxControlOutboundRequest) => Promise<ResponseFrame>;
  exclusive: boolean;
}): Promise<WorktreeRuntimeDeletionJournal> {
  const startedAt = Date.now();
  let stage = 'load_journal';
  let cleanupMode = 'pending';
  let result = 'failed';
  let journal: WorktreeRuntimeDeletionJournal | undefined;
  logControlDiagnostic('worktree_runtime_cleanup', {
    worktreeId: input.request.worktreeId,
    sandboxId: input.request.location.sandboxId,
    provider: input.request.location.provider,
    exclusive: input.exclusive,
    phase: 'started',
  });
  try {
    const key = `${WORKTREE_DELETION_PREFIX}${input.request.worktreeId}`;
    const previous = await loadWorktreeDeletionJournal(input.storage, input.request.worktreeId);
    const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...input.request.sessionIds])];
    const scopedCleanupConfirmed =
      previous?.resourcesCleaned === true && previous.sessionIds.length === sessionIds.length;
    if (scopedCleanupConfirmed && (!input.exclusive || previous.destroyed)) {
      journal = previous;
      cleanupMode = 'journal_reuse';
      result = 'replayed';
      return previous;
    }
    journal = {
      sessionIds,
      resourcesCleaned: scopedCleanupConfirmed,
      destroyed: previous?.destroyed ?? false,
      completed: false,
      exclusiveTeardown: input.exclusive || (previous?.exclusiveTeardown ?? false),
    };
    stage = 'persist_manifest';
    await input.storage.put(key, journal);
    stage = 'inspect_runtime';
    if (await isUnallocatedControlRuntime(input.storage, input.hasConnection)) {
      cleanupMode = 'unallocated';
      journal.resourcesCleaned = true;
      journal.destroyed = input.exclusive;
      stage = 'persist_result';
      await input.storage.put(key, journal);
      result = 'resources_cleaned';
      return journal;
    }
    const record = await loadAllocationRecord(input.storage);
    if (record.state.kind === 'stopped') {
      cleanupMode = 'already_stopped';
      journal.resourcesCleaned = true;
      journal.destroyed = input.exclusive;
      stage = 'persist_result';
      await input.storage.put(key, journal);
      result = 'resources_cleaned';
      return journal;
    }
    stage = 'resolve_provider';
    const provider = await input.getProvider();
    if (input.exclusive) {
      cleanupMode = 'exclusive_stop';
      stage = 'stop_provider';
      if ((await input.stopRuntime()).state.kind !== 'stopped') {
        throw new Error('Worktree provider stop is unconfirmed');
      }
      journal.destroyed = true;
    } else if (input.hasConnection()) {
      cleanupMode = 'shared_wrapper';
      stage = 'prepare_deletion';
      const payload = {
        worktreeId: input.request.worktreeId,
        directory: input.directory,
        sessionIds,
      };
      const prepared = await input.sendRequest({
        operation: 'worktree.prepareDeletion',
        payload,
        timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
      });
      if (!prepared.ok) throw new Error('Worktree runtime preparation is incomplete');
      const discovery = worktreePrepareDeletionResultSchema.parse(prepared.result);
      journal.sessionIds = [...new Set([...sessionIds, ...discovery.sessionIds])];
      stage = 'persist_manifest';
      await input.storage.put(key, journal);
      stage = 'delete_runtime';
      const deleted = await input.sendRequest({
        operation: 'worktree.delete',
        payload: { ...payload, sessionIds: journal.sessionIds },
        timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
      });
      if (!deleted.ok) throw new Error('Worktree runtime cleanup is incomplete');
      stage = 'validate_manifest';
      const confirmed = worktreeDeleteResultSchema.parse(deleted.result);
      if (journal.sessionIds.some(id => !confirmed.sessionIds.includes(id))) {
        throw new Error('Worktree runtime cleanup manifest is incomplete');
      }
      journal.sessionIds = [...new Set([...journal.sessionIds, ...confirmed.sessionIds])];
    } else {
      cleanupMode = 'terminal_observation';
      stage = 'observe_provider';
      const observed = await withTimeout(
        provider.observe(providerRefOf(record), providerIntentOf(record)),
        DEADLINE_MS.stopAttempt,
        'Worktree provider observation timed out'
      );
      if (observed.status !== 'terminal') {
        throw new Error('Shared worktree runtime must reconnect before cleanup');
      }
    }
    stage = 'allocation_fence';
    const current = await loadAllocationRecord(input.storage);
    if (
      !input.exclusive &&
      current.state.kind !== 'stopped' &&
      !sameAllocationIdentity(record, current)
    ) {
      throw new Error('Worktree provider allocation changed during cleanup');
    }
    journal.resourcesCleaned = true;
    stage = 'persist_result';
    await input.storage.put(key, journal);
    result = 'resources_cleaned';
    return journal;
  } finally {
    const confirmed = result === 'failed' ? undefined : journal;
    logControlDiagnostic(
      'worktree_runtime_cleanup',
      {
        worktreeId: input.request.worktreeId,
        sandboxId: input.request.location.sandboxId,
        provider: input.request.location.provider,
        exclusive: input.exclusive,
        phase: 'finished',
        cleanupMode,
        stage,
        result,
        sessionCount: journal?.sessionIds.length ?? input.request.sessionIds.length,
        resourcesCleaned: confirmed?.resourcesCleaned,
        destroyed: confirmed?.destroyed,
        completed: confirmed?.completed,
        durationMs: Date.now() - startedAt,
      },
      result === 'failed' ? 'warn' : 'info'
    );
  }
}
