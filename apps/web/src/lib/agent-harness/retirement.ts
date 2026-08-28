import 'server-only';
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DrizzleClient } from '@kilocode/db/client';
import {
  agent_harness_clients as clients,
  agent_harness_conversation_registry as registry,
  agent_harness_retirements as retirements,
  kilocode_users,
  organizations,
  quick_chat_threads as threads,
} from '@kilocode/db/schema';
import { SOFT_DELETED_BLOCK_REASON_PREFIX } from '@kilocode/db/user-soft-delete-reasons';
import type { DrizzleTransaction } from '@/lib/drizzle';
import type { LegacyHistoryImport } from './history';

const Identity = z.object({ threadId: z.uuid(), generation: z.int().nonnegative() });
const Claim = Identity.extend({ leaseToken: z.uuid() });
const Receipt = Identity.extend({ durable: z.literal(true) }).strict();
const BatchLimit = z.int().min(1).max(10);
type Retirement = z.infer<typeof Identity>;
type RetirementClaim = z.infer<typeof Claim>;
export type HarnessMaintenanceRequest =
  | ({ type: 'purge'; protocolVersion: 1 } & Retirement)
  | ({ type: 'importLegacy'; protocolVersion: 1 } & LegacyHistoryImport);

/** The caller owns the deletion transaction. No Worker request participates in its success contract. */
export async function retireHarnessConversations(
  tx: DrizzleTransaction,
  scope: { userId: string } | { organizationId: string }
) {
  const threadScope =
    'userId' in scope
      ? eq(threads.user_id, scope.userId)
      : eq(threads.organization_id, scope.organizationId);
  const registryScope =
    'userId' in scope
      ? eq(registry.user_id, scope.userId)
      : eq(registry.organization_id, scope.organizationId);
  const reason = 'userId' in scope ? 'account_deleted' : 'context_retired';
  // Match runtime admission: lock threads before the registry and the caller's organization guard.
  await tx
    .select({ id: threads.id })
    .from(threads)
    .where(threadScope)
    .orderBy(threads.id)
    .for('update');
  // Old threads lack a registry generation. Keep zero until old threads and writers are gone.
  await tx.execute(sql`
    INSERT INTO ${retirements} (thread_id, generation, reason)
    SELECT ${threads.id}, COALESCE(${registry.generation}, 0), ${reason}
    FROM ${threads} LEFT JOIN ${registry} ON ${registry.thread_id} = ${threads.id}
    WHERE ${threadScope}
    UNION SELECT thread_id, generation, ${reason} FROM ${registry} WHERE ${registryScope}
    ON CONFLICT (thread_id, generation) DO NOTHING
  `);
  await tx
    .update(registry)
    .set({ user_id: null, organization_id: null })
    .where(
      or(
        registryScope,
        inArray(registry.thread_id, tx.select({ id: threads.id }).from(threads).where(threadScope))
      )
    );
  // Cascades remove text, grants, and invitation results, but never the registry or fences.
  await tx.delete(threads).where(threadScope);
}

export function createHarnessRetirementStore(primary: DrizzleClient['db']) {
  async function sweep(limit = 10) {
    BatchLimit.parse(limit);
    return primary.transaction(async tx => {
      // Old servers also leave installations that never registered a conversation.
      await tx.execute(sql`
        WITH obsolete AS (
          SELECT client.id FROM ${clients} AS client
          JOIN ${kilocode_users} AS owner ON owner.id = client.user_id
          WHERE owner.blocked_reason LIKE ${`${SOFT_DELETED_BLOCK_REASON_PREFIX}%`}
          ORDER BY client.id LIMIT ${limit} FOR UPDATE OF client SKIP LOCKED
        )
        DELETE FROM ${clients} AS client USING obsolete WHERE client.id = obsolete.id
      `);
      // Old servers delete without a fence. These row locks lease one bounded orphan batch.
      const result = await tx.execute(sql`
        SELECT registry.thread_id AS "threadId", registry.generation,
          (owner.id IS NULL OR COALESCE(owner.blocked_reason LIKE ${`${SOFT_DELETED_BLOCK_REASON_PREFIX}%`}, false)) AS "accountDeleted"
        FROM ${registry} AS registry
        LEFT JOIN ${threads} AS thread ON thread.id = registry.thread_id
        LEFT JOIN ${kilocode_users} AS owner ON owner.id = registry.user_id
        LEFT JOIN ${organizations} AS context ON context.id = registry.organization_id
        WHERE NOT EXISTS (SELECT 1 FROM ${retirements} AS fence
          WHERE fence.thread_id = registry.thread_id AND fence.generation = registry.generation)
          AND (thread.id IS NULL OR thread.user_id IS DISTINCT FROM registry.user_id
            OR thread.organization_id IS DISTINCT FROM registry.organization_id OR owner.id IS NULL
            OR owner.blocked_reason LIKE ${`${SOFT_DELETED_BLOCK_REASON_PREFIX}%`}
            OR (registry.organization_id IS NOT NULL AND (context.id IS NULL OR context.deleted_at IS NOT NULL)))
        ORDER BY registry.created_at, registry.thread_id LIMIT ${limit}
        FOR UPDATE OF registry SKIP LOCKED
      `);
      const rows = z.array(Identity.extend({ accountDeleted: z.boolean() })).parse(result.rows);
      if (!rows.length) return 0;
      const ids = rows.map(row => row.threadId);
      await tx
        .insert(retirements)
        .values(
          rows.map(row => ({
            thread_id: row.threadId,
            generation: row.generation,
            reason: row.accountDeleted
              ? ('account_deleted' as const)
              : ('context_retired' as const),
          }))
        )
        .onConflictDoNothing();
      await tx
        .update(registry)
        .set({ user_id: null, organization_id: null })
        .where(inArray(registry.thread_id, ids));
      await tx.delete(threads).where(inArray(threads.id, ids));
      return rows.length;
    });
  }

  async function claim(limit = 10): Promise<RetirementClaim[]> {
    BatchLimit.parse(limit);
    const { rows } = await primary.execute(sql`
      WITH candidates AS (
        SELECT thread_id, generation FROM ${retirements}
        WHERE acknowledged_at IS NULL AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        ORDER BY lease_expires_at NULLS FIRST, thread_id, generation LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${retirements} AS fence SET lease_token = gen_random_uuid(),
        lease_expires_at = clock_timestamp() + interval '60 seconds'
      FROM candidates WHERE fence.thread_id = candidates.thread_id AND fence.generation = candidates.generation
      RETURNING fence.thread_id AS "threadId", fence.generation, fence.lease_token AS "leaseToken"
    `);
    return z.array(Claim).parse(rows);
  }

  async function acknowledge(input: RetirementClaim) {
    const claim = Claim.parse(input);
    return primary.transaction(async tx => {
      const acknowledged = await tx
        .update(retirements)
        .set({
          acknowledged_at: sql`clock_timestamp()`,
          lease_token: null,
          lease_expires_at: null,
        })
        .where(
          and(
            eq(retirements.thread_id, claim.threadId),
            eq(retirements.generation, claim.generation),
            eq(retirements.lease_token, claim.leaseToken),
            isNull(retirements.acknowledged_at),
            sql`${retirements.lease_expires_at} > clock_timestamp()`
          )
        )
        .returning({ threadId: retirements.thread_id });
      if (!acknowledged.length) return false;
      await tx
        .delete(registry)
        .where(
          and(eq(registry.thread_id, claim.threadId), eq(registry.generation, claim.generation))
        );
      // The permanent fence remains even after the last payload and discovery row disappear.
      await tx.delete(threads).where(eq(threads.id, claim.threadId));
      return true;
    });
  }
  return { sweep, claim, acknowledge };
}

export async function drainHarnessRetirements(
  source: Pick<ReturnType<typeof createHarnessRetirementStore>, 'claim' | 'acknowledge'>,
  purge: (
    request: Extract<HarnessMaintenanceRequest, { type: 'purge' }>,
    dispatchId: string
  ) => Promise<unknown>
) {
  const summary = { acknowledged: 0, retry: 0 };
  for (const claim of await source.claim()) {
    try {
      const receipt = Receipt.parse(
        await purge(
          {
            type: 'purge',
            protocolVersion: 1,
            threadId: claim.threadId,
            generation: claim.generation,
          },
          claim.leaseToken
        )
      );
      if (receipt.threadId !== claim.threadId || receipt.generation !== claim.generation)
        throw new Error('Mismatched purge receipt');
      if (!(await source.acknowledge(claim))) throw new Error('Expired purge lease');
      summary.acknowledged++;
    } catch {
      // One attempt per lease; the next cron can retry after expiry, including a lost acknowledgment.
      summary.retry++;
    }
  }
  return summary;
}

/** Maintenance cannot execute tools or create primary authority; purge uses a fence, not a deleted user's grant. */
export async function sendHarnessMaintenance(
  endpoint: string | undefined,
  signingKey: string,
  serviceKey: string | undefined,
  request: HarnessMaintenanceRequest,
  dispatchId: string,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  if (!endpoint || !signingKey || !serviceKey)
    throw new Error('Harness maintenance is not configured');
  const url = new URL('/internal/maintenance', endpoint);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  )
    throw new Error('Invalid harness maintenance URL');
  const body = JSON.stringify(request);
  const identity = request.type === 'purge' ? Identity.parse(request) : request.authority;
  const token = jwt.sign(
    {
      operation: request.type,
      ...identity,
      dispatchId,
      inputDigest: createHash('sha256').update(body).digest('hex'),
    },
    signingKey,
    {
      algorithm: 'HS256',
      issuer: 'agent-harness',
      audience: 'agent-harness:maintenance',
      expiresIn: 60,
    }
  );
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-internal-api-key': serviceKey,
    },
    body,
  });
  if (
    !response.ok ||
    response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
  ) {
    await response.body?.cancel();
    throw new Error('Invalid harness maintenance response');
  }
  if (!response.body) throw new Error('Missing harness maintenance receipt');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) throw new Error('Harness maintenance receipt exceeds limit');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel();
  }
}
