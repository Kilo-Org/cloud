import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { WorkerDb } from '@kilocode/db/client';
import { operation_ledgers } from '@kilocode/db/schema';
import {
  cloudAgentWorktreeLocationSchema,
  sessionIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
  type CloudAgentWorktreeId,
  type CloudAgentWorktreeLocation,
} from '@kilocode/session-ingest-contracts';

const allocationSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  kiloSessionId: sessionIdSchema,
  sandboxId: cloudAgentWorktreeLocationSchema.shape.sandboxId,
  sandboxProvider: cloudAgentWorktreeLocationSchema.shape.provider,
});

type SessionAllocation = z.infer<typeof allocationSchema> & { organizationId: string | null };

export function firstWorktreeSessionId(worktreeId: CloudAgentWorktreeId): `workspace_${string}` {
  return `workspace_${worktreeId.slice('worktree_'.length)}`;
}

export async function readSessionAllocations(
  db: Pick<WorkerDb, 'select'>,
  kiloUserId: string,
  cloudAgentSessionIds: string[]
): Promise<SessionAllocation[]> {
  if (cloudAgentSessionIds.length === 0) return [];
  const ids = [...new Set(cloudAgentSessionIds)];
  const rows = await db
    .select({
      kilo_user_id: operation_ledgers.kilo_user_id,
      organization_id: operation_ledgers.organization_id,
      intent: operation_ledgers.intent,
      resource_key: operation_ledgers.resource_key,
      canonical_result: operation_ledgers.canonical_result,
    })
    .from(operation_ledgers)
    .where(
      and(
        eq(operation_ledgers.kilo_user_id, kiloUserId),
        eq(operation_ledgers.domain, 'session'),
        eq(operation_ledgers.intent, 'create_cloud'),
        inArray(sql<string>`${operation_ledgers.canonical_result}->>'cloudAgentSessionId'`, ids)
      )
    );
  return rows.flatMap(row => {
    if (
      row.kilo_user_id !== kiloUserId ||
      row.intent !== 'create_cloud' ||
      row.resource_key !== null
    )
      return [];
    const parsed = allocationSchema.safeParse(row.canonical_result);
    if (!parsed.success || !ids.includes(parsed.data.cloudAgentSessionId)) return [];
    return [{ ...parsed.data, organizationId: row.organization_id }];
  });
}

export function allocationLocation(
  allocations: SessionAllocation[],
  identity: { cloudAgentSessionId: string; sessionId: string | null; organizationId: string | null }
): CloudAgentWorktreeLocation | undefined {
  const matches = allocations.filter(
    allocation =>
      allocation.cloudAgentSessionId === identity.cloudAgentSessionId &&
      allocation.organizationId === identity.organizationId
  );
  const first = matches[0];
  if (!first) return undefined;
  if (
    matches.some(
      allocation =>
        (identity.sessionId !== null && allocation.kiloSessionId !== identity.sessionId) ||
        allocation.kiloSessionId !== first.kiloSessionId ||
        allocation.sandboxId !== first.sandboxId ||
        allocation.sandboxProvider !== first.sandboxProvider
    )
  )
    throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
  return { sandboxId: first.sandboxId, provider: first.sandboxProvider };
}
