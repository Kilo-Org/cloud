import 'server-only';

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { decryptApiKey, encryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';
import { isChatGptUsageLimitCurrent, type ChatGptUsageLimit } from './usage-limit';

/**
 * The delegated "Sign in with ChatGPT" tokens are the OpenAI BYOK credential.
 * The integration is inherently personal, so a connection is owned by one
 * person and scoped to one account: their personal account (`organizationId`
 * null) or one organization they belong to. The same person can connect the
 * same ChatGPT subscription to several accounts by connecting each separately,
 * so the owner is the `(kiloUserId, organizationId)` pair.
 *
 * One row per organization can also be the organization's shared-services
 * connection: it is connected by an organization owner, it is what the
 * platform's own callers use, and it belongs to no member.
 */

/**
 * The account a connection belongs to. A member connection is the
 * `(kiloUserId, organizationId)` pair. The organization's shared-services
 * connection is its own single row, and no read depends on the person who
 * connected it.
 */
export type OpenAiChatGptOwner =
  | { kiloUserId: string; organizationId: string | null; scope?: undefined }
  | { kiloUserId?: undefined; organizationId: string; scope: 'shared_services' };

/**
 * The organization's shared-services connection. It is the connection the
 * platform's own callers (code reviewer, Slack bot, auto-triage) use instead of
 * a member's personal connection.
 */
export function openAiChatGptSharedServicesOwner(organizationId: string): OpenAiChatGptOwner {
  return { organizationId, scope: 'shared_services' };
}

/** Stable identity for per-owner state such as the in-flight refresh map. */
export function openAiChatGptOwnerKey(owner: OpenAiChatGptOwner): string {
  if (owner.scope === 'shared_services') return `shared-services:${owner.organizationId}`;
  return `${owner.kiloUserId}:${owner.organizationId ?? 'personal'}`;
}

/** Matches the owner's row for reads, updates and deletes. */
export function openAiChatGptOwnerWhere(owner: OpenAiChatGptOwner): SQL | undefined {
  if (owner.scope === 'shared_services') {
    return and(
      eq(openai_chatgpt_connections.organization_id, owner.organizationId),
      eq(openai_chatgpt_connections.is_shared_services, true)
    );
  }
  return and(
    eq(openai_chatgpt_connections.kilo_user_id, owner.kiloUserId),
    eq(openai_chatgpt_connections.is_shared_services, false),
    owner.organizationId === null
      ? isNull(openai_chatgpt_connections.organization_id)
      : eq(openai_chatgpt_connections.organization_id, owner.organizationId)
  );
}

/** Either the primary database or an open transaction. */
export type OpenAiChatGptDatabase = typeof db | DrizzleTransaction;

/**
 * Reads the raw connection row. `options.forUpdate` takes a `SELECT ... FOR
 * UPDATE` row lock, used inside a transaction so a concurrent refresh in
 * another process cannot interleave. `is_enabled` is read with the payload: a
 * person can disable the row through the ordinary BYOK toggle without touching
 * the stored status, so the payload alone cannot decide eligibility.
 */
export async function readOpenAiChatGptConnectionRow(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  options: { forUpdate?: boolean } = {}
) {
  const query = fromDb
    .select({
      encrypted_connection: openai_chatgpt_connections.encrypted_connection,
      is_enabled: openai_chatgpt_connections.is_enabled,
    })
    .from(openai_chatgpt_connections)
    .where(openAiChatGptOwnerWhere(owner));

  const rows = options.forUpdate ? await query.for('update').limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

/**
 * Decrypts and parses a stored payload. A row encrypted with a rotated key, a
 * truncated blob or a payload written by an older shape returns null instead of
 * throwing, so a corrupt row can never take down the sign-in or a request.
 */
export function decryptOpenAiChatGptConnection(
  encrypted: EncryptedData
): OpenAiChatGptConnection | null {
  try {
    const parsed = OpenAiChatGptConnectionSchema.safeParse(
      JSON.parse(decryptApiKey(encrypted, BYOK_ENCRYPTION_KEY))
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function getOpenAiChatGptConnection(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptConnection | null> {
  const row = await readOpenAiChatGptConnectionRow(db, owner);
  return row ? decryptOpenAiChatGptConnection(row.encrypted_connection) : null;
}

/**
 * The stored payload together with the row's own enabled flag. Routing must use
 * this: a person can disable the row through the ordinary BYOK toggle, and the
 * payload keeps saying `connected` because the toggle does not rewrite it. The
 * status router deliberately keeps using `getOpenAiChatGptConnection`, so a
 * terminal refresh failure still surfaces its reconnect message.
 */
export async function getOpenAiChatGptStoredConnection(
  owner: OpenAiChatGptOwner
): Promise<{ connection: OpenAiChatGptConnection; isEnabled: boolean } | null> {
  const row = await readOpenAiChatGptConnectionRow(db, owner);
  if (!row) return null;
  const connection = decryptOpenAiChatGptConnection(row.encrypted_connection);
  return connection ? { connection, isEnabled: row.is_enabled } : null;
}

/**
 * Inserts or replaces the owner's connection. The upsert targets the owner's
 * unique index, so reconnecting never leaves a second row behind. The row is
 * always left enabled and connected with any previous error state cleared.
 * `createdBy` is the acting person and is recorded on organization rows.
 */
export async function saveOpenAiChatGptConnection(
  owner: OpenAiChatGptOwner,
  connection: OpenAiChatGptConnection,
  createdBy: string
): Promise<void> {
  const stored: OpenAiChatGptConnection = {
    ...connection,
    status: 'connected',
    error_message: undefined,
    error_at: undefined,
  };
  const encrypted_connection = encryptApiKey(JSON.stringify(stored), BYOK_ENCRYPTION_KEY);
  // The shared-services row records the connecting person in `kilo_user_id`; its
  // reads never match on that column.
  const values = {
    kilo_user_id: owner.scope === 'shared_services' ? createdBy : owner.kiloUserId,
    organization_id: owner.organizationId,
    is_shared_services: owner.scope === 'shared_services',
    encrypted_connection,
    is_enabled: true,
    created_by: createdBy,
    usage_limit_reached_at: null,
    usage_limit_resets_at: null,
  };

  // Each owner shape upserts through its own partial unique index.
  const conflict =
    owner.scope === 'shared_services'
      ? {
          target: [openai_chatgpt_connections.organization_id],
          targetWhere: sql`${openai_chatgpt_connections.is_shared_services} = true`,
        }
      : owner.organizationId === null
        ? {
            target: [openai_chatgpt_connections.kilo_user_id],
            targetWhere: sql`${openai_chatgpt_connections.organization_id} IS NULL`,
          }
        : {
            target: [
              openai_chatgpt_connections.kilo_user_id,
              openai_chatgpt_connections.organization_id,
            ],
            targetWhere: sql`${openai_chatgpt_connections.organization_id} IS NOT NULL AND ${openai_chatgpt_connections.is_shared_services} = false`,
          };

  await db
    .insert(openai_chatgpt_connections)
    .values(values)
    .onConflictDoUpdate({
      ...conflict,
      set: {
        encrypted_connection,
        is_enabled: true,
        usage_limit_reached_at: null,
        usage_limit_resets_at: null,
      },
    });
}

/** Deletes the owner's stored connection. */
export async function clearOpenAiChatGptConnection(owner: OpenAiChatGptOwner): Promise<void> {
  await db.delete(openai_chatgpt_connections).where(openAiChatGptOwnerWhere(owner));
}

/**
 * The owner's recorded plan limit, when one is still current. An expired record
 * stays in the row and is filtered here instead of being cleared, so this read
 * never writes; a reconnect resets the columns.
 */
export async function readOpenAiChatGptUsageLimit(
  owner: OpenAiChatGptOwner,
  now: number = Date.now()
): Promise<{ reachedAt: string; resetsAt: string | null } | null> {
  const rows = await db
    .select({
      usage_limit_reached_at: openai_chatgpt_connections.usage_limit_reached_at,
      usage_limit_resets_at: openai_chatgpt_connections.usage_limit_resets_at,
    })
    .from(openai_chatgpt_connections)
    .where(openAiChatGptOwnerWhere(owner))
    .limit(1);

  const row = rows[0];
  if (!row?.usage_limit_reached_at) return null;
  if (!isChatGptUsageLimitCurrent(row.usage_limit_reached_at, row.usage_limit_resets_at, now)) {
    return null;
  }

  return {
    // The status contract is JSON, so a PostgreSQL timestamp string is
    // normalized to ISO before it leaves the database layer.
    reachedAt: new Date(row.usage_limit_reached_at).toISOString(),
    resetsAt: row.usage_limit_resets_at ? new Date(row.usage_limit_resets_at).toISOString() : null,
  };
}

/**
 * Records the plan limit OpenAI reported on a delegated request. A missing row
 * is a no-op: the connection was disconnected while the request was in flight,
 * and recreating the row would resurrect a credential nobody owns.
 */
export async function recordOpenAiChatGptUsageLimit(
  owner: OpenAiChatGptOwner,
  limit: ChatGptUsageLimit
): Promise<void> {
  await db
    .update(openai_chatgpt_connections)
    .set({
      usage_limit_reached_at: new Date().toISOString(),
      usage_limit_resets_at:
        limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString(),
    })
    .where(openAiChatGptOwnerWhere(owner));
}

/**
 * Records a terminal connection failure and clears the stored token set: the
 * access and refresh tokens are dropped because OpenAI has already rejected
 * them, the row is disabled so no request retries the dead credential, and the
 * status fields tell the UI to show the reconnect message.
 *
 * The caller passes the connection it decided on, and the database to write
 * through. The refresh path calls this inside the transaction that holds the
 * `SELECT ... FOR UPDATE` row lock, so a reconnect that lands between the
 * rejected token exchange and this write cannot be erased by a stale failure.
 */
export async function markOpenAiChatGptConnectionErrored(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  connection: OpenAiChatGptConnection,
  message: string
): Promise<void> {
  const { refresh_token: _refreshToken, ...withoutTokens } = connection;
  const errored: OpenAiChatGptConnection = {
    ...withoutTokens,
    access_token: '',
    expires_at: 0,
    status: 'error',
    error_message: message,
    error_at: new Date().toISOString(),
  };

  await fromDb
    .update(openai_chatgpt_connections)
    .set({
      encrypted_connection: encryptApiKey(JSON.stringify(errored), BYOK_ENCRYPTION_KEY),
      is_enabled: false,
    })
    .where(openAiChatGptOwnerWhere(owner));
}

/**
 * Terminal-failure write for callers outside a transaction. A missing row is a
 * no-op. The refresh path uses `markOpenAiChatGptConnectionErrored` directly so
 * the write stays inside the row lock.
 */
export async function markOpenAiChatGptError(
  owner: OpenAiChatGptOwner,
  message: string
): Promise<void> {
  const connection = await getOpenAiChatGptConnection(owner);
  if (!connection) return;

  await markOpenAiChatGptConnectionErrored(db, owner, connection, message);
}
