import { z } from 'zod';
import { withTimeout } from '@kilocode/worker-utils';
import {
  canDestroyCloudAgentWorktreeSandboxSchema,
  cloudAgentWorktreeIdSchema,
  sessionIdSchema,
} from '@kilocode/session-ingest-contracts';
import type { ProviderAdapter } from './provider';
import { loadPhysicalRecord, loadRouteTable } from './durable-state';
import { sameAllocation, type PhysicalRecord } from './physical-lifecycle';
import { DEADLINE_MS } from './deadlines';
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
  const physical = await loadPhysicalRecord(storage);
  return (
    physical.state === 'stopped' &&
    physical.providerRef === null &&
    physical.createIntent === null &&
    physical.stopTombstone === null &&
    (await loadRouteTable(storage)).size === 0 &&
    !hasConnection()
  );
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
  stopRuntime: () => Promise<PhysicalRecord>;
  hasConnection: () => boolean;
  sendRequest: (request: SandboxControlOutboundRequest) => Promise<ResponseFrame>;
  exclusive: boolean;
}): Promise<WorktreeRuntimeDeletionJournal> {
  const key = `${WORKTREE_DELETION_PREFIX}${input.request.worktreeId}`;
  const previous = await loadWorktreeDeletionJournal(input.storage, input.request.worktreeId);
  const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...input.request.sessionIds])];
  const scopedCleanupConfirmed =
    previous?.resourcesCleaned === true && previous.sessionIds.length === sessionIds.length;
  if (scopedCleanupConfirmed && (!input.exclusive || previous.destroyed)) return previous;
  const journal: WorktreeRuntimeDeletionJournal = {
    sessionIds,
    resourcesCleaned: scopedCleanupConfirmed,
    destroyed: previous?.destroyed ?? false,
    completed: false,
    exclusiveTeardown: input.exclusive || (previous?.exclusiveTeardown ?? false),
  };
  await input.storage.put(key, journal);
  if (await isUnallocatedControlRuntime(input.storage, input.hasConnection)) {
    journal.resourcesCleaned = true;
    journal.destroyed = input.exclusive;
    await input.storage.put(key, journal);
    return journal;
  }
  const physical = await loadPhysicalRecord(input.storage);
  if (physical.state === 'stopped') {
    journal.resourcesCleaned = true;
    journal.destroyed = input.exclusive;
    await input.storage.put(key, journal);
    return journal;
  }
  const provider = await input.getProvider();
  if (input.exclusive) {
    if ((await input.stopRuntime()).state !== 'stopped') {
      throw new Error('Worktree provider stop is unconfirmed');
    }
    journal.destroyed = true;
  } else if (input.hasConnection()) {
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
    await input.storage.put(key, journal);
    const deleted = await input.sendRequest({
      operation: 'worktree.delete',
      payload: { ...payload, sessionIds: journal.sessionIds },
      timeoutMs: SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
    });
    if (!deleted.ok) throw new Error('Worktree runtime cleanup is incomplete');
    const confirmed = worktreeDeleteResultSchema.parse(deleted.result);
    if (journal.sessionIds.some(id => !confirmed.sessionIds.includes(id))) {
      throw new Error('Worktree runtime cleanup manifest is incomplete');
    }
    journal.sessionIds = [...new Set([...journal.sessionIds, ...confirmed.sessionIds])];
  } else {
    const observed = await withTimeout(
      provider.observe(physical.providerRef, physical.createIntent),
      DEADLINE_MS.stopAttempt,
      'Worktree provider observation timed out'
    );
    if (observed.status !== 'terminal') {
      throw new Error('Shared worktree runtime must reconnect before cleanup');
    }
  }
  const current = await loadPhysicalRecord(input.storage);
  if (!input.exclusive && current.state !== 'stopped' && !sameAllocation(physical, current)) {
    throw new Error('Worktree provider allocation changed during cleanup');
  }
  journal.resourcesCleaned = true;
  await input.storage.put(key, journal);
  return journal;
}
