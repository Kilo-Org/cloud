import { DurableObject } from 'cloudflare:workers';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { deleteWorktreeResources } from '../router/handlers/worktree-deletion.js';
import type { Env } from '../types.js';
import {
  StartWorktreeCleanupInput,
  StoredWorktreeCleanupBatch,
  StoredWorktreeCleanupItem,
  WorktreeCleanup,
  WorktreeCleanupOwner,
} from './schemas.js';

const MAX_ATTEMPTS = 3;
const RECOVERY_DELAY_MS = 30_000;
const ITEM_PREFIX = 'item:';

async function readBatch(storage: DurableObjectTransaction) {
  const raw = await storage.get('batch');
  if (raw === undefined) return null;
  const batch = StoredWorktreeCleanupBatch.parse(raw);
  const records = await storage.list({ prefix: ITEM_PREFIX });
  const entries = [...records].map(([key, value]) => ({
    key,
    item: StoredWorktreeCleanupItem.parse(value),
  }));
  return { batch, entries };
}

function isActive(item: z.infer<typeof StoredWorktreeCleanupItem>): boolean {
  return item.status === 'pending' || item.status === 'deleting';
}

function cleanupFailure(error: unknown): { retryable: boolean; message: string } {
  if (error instanceof TRPCError) {
    const cause = error.cause;
    return {
      retryable:
        cause && 'retryable' in cause && typeof cause.retryable === 'boolean'
          ? cause.retryable
          : ['TIMEOUT', 'SERVICE_UNAVAILABLE', 'TOO_MANY_REQUESTS'].includes(error.code),
      message: error.message,
    };
  }
  return {
    retryable:
      typeof error === 'object' &&
      error !== null &&
      'retryable' in error &&
      error.retryable === true,
    message: 'Worktree cleanup failed unexpectedly',
  };
}

export class WorktreeCleanupCoordinator extends DurableObject<Env> {
  async start(ownerInput: WorktreeCleanupOwner, input: z.infer<typeof StartWorktreeCleanupInput>) {
    const owner = WorktreeCleanupOwner.parse(ownerInput);
    const { worktreeIds } = StartWorktreeCleanupInput.parse(input);
    return this.ctx.storage.transaction(async storage => {
      const current = await readBatch(storage);
      if (current) {
        this.assertOwner(current.batch.owner, owner);
        if (current.entries.some(({ item }) => isActive(item))) {
          return WorktreeCleanup.parse({
            ...current.batch,
            items: current.entries.map(({ item }) => item),
          });
        }
        for (const { key } of current.entries) await storage.delete(key);
      }
      const batch = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), owner };
      const items = [...new Set(worktreeIds)].map(worktreeId => ({
        worktreeId,
        status: 'pending' as const,
        attempts: 0,
        deletedSessionIds: [],
        error: null,
      }));
      await storage.put('batch', batch);
      for (const [index, item] of items.entries()) {
        await storage.put(`${ITEM_PREFIX}${String(index).padStart(4, '0')}`, item);
      }
      await storage.setAlarm(Date.now() + 1000);
      return WorktreeCleanup.parse({ ...batch, items });
    });
  }

  async get(ownerInput: WorktreeCleanupOwner): Promise<WorktreeCleanup | null> {
    const owner = WorktreeCleanupOwner.parse(ownerInput);
    return this.ctx.storage.transaction(async storage => {
      const current = await readBatch(storage);
      if (!current) return null;
      this.assertOwner(current.batch.owner, owner);
      return WorktreeCleanup.parse({
        ...current.batch,
        items: current.entries.map(({ item }) => item),
      });
    });
  }

  async alarm(): Promise<void> {
    const next = await this.ctx.storage.transaction(async storage => {
      const current = await readBatch(storage);
      const entry = current?.entries.find(({ item }) => isActive(item));
      if (!current || !entry) {
        await storage.deleteAlarm();
        return null;
      }
      if (entry.item.attempts >= MAX_ATTEMPTS) {
        await storage.put(entry.key, {
          ...entry.item,
          status: 'failed',
          error: `Worktree cleanup was interrupted after ${MAX_ATTEMPTS} attempts; start cleanup again to retry`,
        });
        await storage.setAlarm(Date.now() + 1000);
        return null;
      }
      const item = {
        ...entry.item,
        status: 'deleting' as const,
        attempts: entry.item.attempts + 1,
        error: null,
      };
      await storage.put(entry.key, item);
      // This alarm survives an eviction between the external deletion and its result write.
      await storage.setAlarm(Date.now() + RECOVERY_DELAY_MS);
      return { batch: current.batch, key: entry.key, item };
    });
    if (!next) return;

    let item: z.infer<typeof StoredWorktreeCleanupItem> = next.item;
    let retryDelayMs = 1000;
    try {
      const result = await deleteWorktreeResources(
        {
          worktreeId: item.worktreeId,
          kilocodeOrganizationId: next.batch.owner.kilocodeOrganizationId,
          requireMergedPullRequests: true,
        },
        { env: this.env, userId: next.batch.owner.userId }
      );
      item = { ...item, status: 'deleted', deletedSessionIds: result.deletedSessionIds };
    } catch (error) {
      const failure = cleanupFailure(error);
      const retry = failure.retryable && item.attempts < MAX_ATTEMPTS;
      item = {
        ...item,
        status: retry ? 'pending' : 'failed',
        error: retry
          ? `${failure.message}; retrying automatically`
          : failure.retryable
            ? `${failure.message}; cleanup stopped after ${MAX_ATTEMPTS} attempts`
            : failure.message,
      };
      if (retry) retryDelayMs = 5000 * 2 ** (item.attempts - 1);
    }
    await this.ctx.storage.transaction(async storage => {
      await storage.put(next.key, item);
      const current = await readBatch(storage);
      if (current?.entries.some(({ item: stored }) => isActive(stored))) {
        await storage.setAlarm(Date.now() + retryDelayMs);
      } else {
        await storage.deleteAlarm();
      }
    });
  }

  private assertOwner(stored: WorktreeCleanupOwner, owner: WorktreeCleanupOwner): void {
    if (
      stored.userId !== owner.userId ||
      stored.kilocodeOrganizationId !== owner.kilocodeOrganizationId
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
    }
  }
}
