import 'server-only';

import { and, eq, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { type IndexColumn } from 'drizzle-orm/pg-core';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db, readDb, type DrizzleConnection } from '@kilocode/web-shared/lib/drizzle';
import { CredentialKmsError } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-credential';
import {
  CLEARED_OPENAI_CHATGPT_CONNECTION_PAYLOAD,
  createOpenAiChatGptSealingKey,
  OPENAI_CHATGPT_ELIGIBILITY_KMS_ACTOR,
  openAiChatGptKmsOwnerFor,
  openOpenAiChatGptConnection,
  sealOpenAiChatGptConnection,
  type OpenAiChatGptEncryptedConnectionColumns,
  type OpenAiChatGptKmsOwner,
  type OpenAiChatGptSealingKey,
} from './connection-encryption';
import type { OpenAiChatGptConnection } from './types';
import { isChatGptUsageLimitCurrent, type ChatGptUsageLimit } from './usage-limit';

/**
 * The clean usage-limit column state. A save, a reconnect, and a successful
 * delegated request each leave no recorded limit, so the three writes must
 * spell the same columns and nulls.
 */
const NO_USAGE_LIMIT = {
  usage_limit_reached_at: null,
  usage_limit_resets_at: null,
  usage_limit_error_code: null,
} as const;

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
 * platform's own callers use, and it belongs to no member. The row stays the
 * organization's and records the connector in `created_by`; a shared row whose
 * connector is gone is not served by routing (the caller's own connection
 * serves instead) and reads as needing a reconnect on the organization's
 * settings.
 *
 * The account a member connection belongs to is that pair; the organization's
 * shared-services connection is its own single row, so no owner matches on the
 * person who connected it. Routing revalidates that person from the row's
 * `created_by`.
 */
export type OpenAiChatGptOwner =
  | { kiloUserId: string; organizationId: string | null; scope?: undefined }
  | { kiloUserId?: undefined; organizationId: string; scope: 'shared_services' };

/**
 * The organization's shared-services connection. It is the connection the
 * platform's own callers (code reviewer, Slack bot) use instead of
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

/**
 * The owner predicate of a shape: at least two column conditions, never absent.
 * drizzle types `and()` as possibly absent because it accepts optional
 * conditions; an owner shape always names its columns, so the predicate exists
 * here. Asserting it once keeps an absent predicate, which would make a
 * `delete(...).where(...)` unfiltered, out of every caller's reach.
 */
function ownerRowWhere(...conditions: [SQL, SQL, ...SQL[]]): SQL {
  return and(...conditions) as SQL;
}

/**
 * What one owner shape contributes to the row predicate, the identity columns a
 * save writes and the upsert target. All three describe the same shape, so they
 * are returned together: a new shape that adds only some of them upserts
 * through the wrong partial index while reads still match the old row.
 */
type OpenAiChatGptOwnerShape = {
  row: SQL;
  /** The identity columns a save writes for this shape. */
  identity: (createdBy: string) => {
    kilo_user_id: string;
    organization_id: string | null;
    is_shared_services: boolean;
  };
  /** The partial unique index this shape upserts through. */
  conflict: { target: IndexColumn[]; targetWhere: SQL };
};

/**
 * Describes the owner shape once. The row predicate, the inserted identity
 * columns and the conflict target must agree on which row a shape owns, so they
 * are written next to each other instead of branching again at every call site.
 */
function openAiChatGptOwnerShape(owner: OpenAiChatGptOwner): OpenAiChatGptOwnerShape {
  if (owner.scope === 'shared_services') {
    const organizationId = owner.organizationId;
    return {
      row: ownerRowWhere(
        eq(openai_chatgpt_connections.organization_id, organizationId),
        eq(openai_chatgpt_connections.is_shared_services, true)
      ),
      identity: createdBy => ({
        kilo_user_id: createdBy,
        organization_id: organizationId,
        is_shared_services: true,
      }),
      conflict: {
        target: [openai_chatgpt_connections.organization_id],
        targetWhere: sql`${openai_chatgpt_connections.is_shared_services} = true`,
      },
    };
  }

  const kiloUserId = owner.kiloUserId;
  if (owner.organizationId === null) {
    return {
      row: ownerRowWhere(
        eq(openai_chatgpt_connections.kilo_user_id, kiloUserId),
        eq(openai_chatgpt_connections.is_shared_services, false),
        isNull(openai_chatgpt_connections.organization_id)
      ),
      identity: () => ({
        kilo_user_id: kiloUserId,
        organization_id: null,
        is_shared_services: false,
      }),
      conflict: {
        target: [openai_chatgpt_connections.kilo_user_id],
        targetWhere: sql`${openai_chatgpt_connections.organization_id} IS NULL`,
      },
    };
  }

  const organizationId = owner.organizationId;
  return {
    row: ownerRowWhere(
      eq(openai_chatgpt_connections.kilo_user_id, kiloUserId),
      eq(openai_chatgpt_connections.is_shared_services, false),
      eq(openai_chatgpt_connections.organization_id, organizationId)
    ),
    identity: () => ({
      kilo_user_id: kiloUserId,
      organization_id: organizationId,
      is_shared_services: false,
    }),
    conflict: {
      target: [openai_chatgpt_connections.kilo_user_id, openai_chatgpt_connections.organization_id],
      targetWhere: sql`${openai_chatgpt_connections.organization_id} IS NOT NULL AND ${openai_chatgpt_connections.is_shared_services} = false`,
    },
  };
}

/**
 * The KMS owner of the owner's row: the organization for its shared-services connection,
 * otherwise the connecting person. `openAiChatGptKmsOwnerOfRow` derives the same owner
 * from the row's columns.
 */
export function openAiChatGptKmsOwner(owner: OpenAiChatGptOwner): OpenAiChatGptKmsOwner {
  return owner.scope === 'shared_services'
    ? openAiChatGptKmsOwnerFor({ kind: 'shared_services', organizationId: owner.organizationId })
    : openAiChatGptKmsOwnerFor({
        kind: 'member',
        kiloUserId: owner.kiloUserId,
        organizationId: owner.organizationId,
      });
}

/**
 * A data key for one write of the owner's connection. It carries no plaintext, so a writer
 * creates it before taking the row lock, and a KMS failure stops the write before anything
 * is sent upstream.
 */
export async function createOpenAiChatGptConnectionSealingKey(
  owner: OpenAiChatGptOwner,
  actorUserId: string
): Promise<OpenAiChatGptSealingKey> {
  return await createOpenAiChatGptSealingKey(openAiChatGptKmsOwner(owner), actorUserId);
}

/** Matches the owner's row for reads, updates and deletes. */
export function openAiChatGptOwnerWhere(owner: OpenAiChatGptOwner): SQL {
  return openAiChatGptOwnerShape(owner).row;
}

/** Either the primary database or an open transaction. */
export type OpenAiChatGptDatabase = DrizzleConnection;

/**
 * Reads the raw connection row. `options.forUpdate` takes a `SELECT ... FOR
 * UPDATE` row lock, used inside a transaction so a concurrent refresh in
 * another process cannot interleave. `is_enabled` is read with the payload: a
 * person can disable the row through the ordinary BYOK toggle without touching
 * the stored status, so the payload alone cannot decide eligibility.
 * `options.onlyWithUsageLimit` matches only a row that records a usage limit, so
 * a locking read of a row without one takes no lock.
 */
export async function readOpenAiChatGptConnectionRow(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  options: { forUpdate?: boolean; onlyWithUsageLimit?: boolean } = {}
) {
  const query = fromDb
    .select({
      encrypted_connection_envelope: openai_chatgpt_connections.encrypted_connection_envelope,
      kilo_user_id: openai_chatgpt_connections.kilo_user_id,
      organization_id: openai_chatgpt_connections.organization_id,
      is_shared_services: openai_chatgpt_connections.is_shared_services,
      is_enabled: openai_chatgpt_connections.is_enabled,
      created_by: openai_chatgpt_connections.created_by,
    })
    .from(openai_chatgpt_connections)
    .where(
      options.onlyWithUsageLimit
        ? and(
            openAiChatGptOwnerWhere(owner),
            isNotNull(openai_chatgpt_connections.usage_limit_reached_at)
          )
        : openAiChatGptOwnerWhere(owner)
    );

  const rows = options.forUpdate ? await query.for('update').limit(1) : await query.limit(1);
  return rows[0] ?? null;
}

/**
 * Decrypts and parses a stored payload. A row without an envelope or a payload written by
 * an older shape returns null instead of throwing, so a corrupt row can never take down the
 * sign-in or a request. A KMS failure throws; `openOpenAiChatGptConnection` explains why.
 */
export async function decryptOpenAiChatGptConnection(
  row: OpenAiChatGptEncryptedConnectionColumns
): Promise<OpenAiChatGptConnection | null> {
  return await openOpenAiChatGptConnection(row);
}

/**
 * The payload a save and a successful refresh both write: connected, with the
 * previous error cleared.
 */
export function healthyOpenAiChatGptConnection(
  connection: OpenAiChatGptConnection
): OpenAiChatGptConnection {
  return { ...connection, status: 'connected', error_message: undefined, error_at: undefined };
}

/**
 * The payload columns a write of the owner's connection sets: the healthy
 * payload, encrypted in both stored forms, on an enabled row. One definition so a
 * reconnect and a token rotation cannot drift apart in which columns they leave alone.
 */
function connectionWriteColumns(
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey
) {
  return {
    ...sealOpenAiChatGptConnection(healthyOpenAiChatGptConnection(connection), sealingKey),
    is_enabled: true,
  };
}

/**
 * The stored payload alone, without the row's `is_enabled`. The status and
 * reconnect-message path reads it: a disabled row must still report the stored
 * status. Routing must use `getOpenAiChatGptStoredConnection` instead, because
 * the ordinary BYOK toggle can disable the row without rewriting the payload.
 *
 * A missing row and a payload that does not decrypt both read as null, so the
 * absent row and the unreadable credential are deliberately indistinguishable.
 */
export async function getOpenAiChatGptConnection(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptConnection | null> {
  return (await getStoredConnection(db, owner))?.connection ?? null;
}

/** The stored payload together with the row's own enabled flag. */
export type OpenAiChatGptStoredConnection = {
  connection: OpenAiChatGptConnection;
  isEnabled: boolean;
  /**
   * The person whose delegated ChatGPT account the row holds. The column is
   * not nullable, so every row records a connector.
   */
  createdBy: string;
};

/** The plan limit a row records, as the read normalizes it. */
export type OpenAiChatGptRecordedUsageLimit = {
  reachedAt: string;
  resetsAt: string | null;
  code: string | null;
};

/**
 * Routing must use this: a person can disable the row through the ordinary BYOK
 * toggle, and the payload keeps saying `connected` because the toggle does not
 * rewrite it. The status router deliberately keeps using
 * `getOpenAiChatGptConnection`, so a terminal refresh failure still surfaces its
 * reconnect message.
 *
 * Reads the replica: it runs before inference on gateway requests, which also
 * execute in sfo1. Token refresh re-reads the row on the primary under a lock.
 * A caller that reports state to a person must use
 * `getOpenAiChatGptStoredConnectionFromPrimary` instead, so a just-reconnected
 * row never reads as the connector it had a moment earlier.
 */
export async function getOpenAiChatGptStoredConnection(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptStoredConnection | null> {
  return await getStoredConnection(readDb, owner);
}

/**
 * The stored row as the primary holds it. A surface that tells a person what
 * their connection is must read this, so the answer matches the payload the same
 * page shows and a reconnect is visible at once.
 */
export async function getOpenAiChatGptStoredConnectionFromPrimary(
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptStoredConnection | null> {
  return await getStoredConnection(db, owner);
}

async function getStoredConnection(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner
): Promise<OpenAiChatGptStoredConnection | null> {
  const row = await readOpenAiChatGptConnectionRow(fromDb, owner);
  if (!row) return null;
  const connection = await decryptOpenAiChatGptConnection(row);
  return connection ? { connection, isEnabled: row.is_enabled, createdBy: row.created_by } : null;
}

/**
 * Writes the owner's connection payload over the owner's row. The caller's
 * connection is used on purpose, so a refresh can write inside the transaction
 * that already holds the `SELECT ... FOR UPDATE` row lock. The write touches
 * only the payload and `is_enabled`: the usage-limit columns and `created_by`
 * are left alone, so a reconnect's connector and recorded limit survive a token
 * rotation. `sealingKey` is created before the lock is taken.
 */
export async function writeOpenAiChatGptConnection(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  connection: OpenAiChatGptConnection,
  sealingKey: OpenAiChatGptSealingKey
): Promise<void> {
  await fromDb
    .update(openai_chatgpt_connections)
    .set(connectionWriteColumns(connection, sealingKey))
    .where(openAiChatGptOwnerWhere(owner));
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
  const columns = connectionWriteColumns(
    connection,
    await createOpenAiChatGptConnectionSealingKey(owner, createdBy)
  );
  const shape = openAiChatGptOwnerShape(owner);
  // The shared-services row records the connecting person in `created_by`; its
  // reads never match on `kilo_user_id`.
  const values = {
    ...shape.identity(createdBy),
    ...columns,
    created_by: createdBy,
    ...NO_USAGE_LIMIT,
  };

  await db
    .insert(openai_chatgpt_connections)
    .values(values)
    // Each owner shape upserts through its own partial unique index.
    .onConflictDoUpdate({
      ...shape.conflict,
      // A reconnect replaces the credential and the connector with it: the
      // shared-services row is the one place a conflict can change the person
      // recorded on the row, and it must name the person who connected the
      // credential it now holds. `created_by` follows the same person, so the
      // row never names a connector who is no longer responsible for it.
      set: {
        kilo_user_id: values.kilo_user_id,
        created_by: values.created_by,
        encrypted_connection: columns.encrypted_connection,
        encrypted_connection_envelope: columns.encrypted_connection_envelope,
        is_enabled: true,
        ...NO_USAGE_LIMIT,
      },
    });
}

export async function clearOpenAiChatGptConnection(owner: OpenAiChatGptOwner): Promise<void> {
  await db.delete(openai_chatgpt_connections).where(openAiChatGptOwnerWhere(owner));
}

/**
 * The owner's recorded plan limit, when one is still current. An expired record
 * stays in the row and is filtered here instead of being cleared, so this read
 * never writes; a reconnect resets the columns.
 *
 * This read takes the primary, not the replica, for the same reason
 * `getOpenAiChatGptStoredConnectionFromPrimary` does: the status query reports
 * the connection to a person. It already reads the connection payload on the
 * primary through `getOpenAiChatGptConnection`, so the payload and the limit
 * come from one database and one status response stays consistent. It also
 * means a limit a request recorded moments ago must be visible at once rather
 * than after the replica lag. No gateway path reads this value: a gateway
 * request records the limit only after the upstream response, so the gateway's
 * pre-inference replica rule does not apply here.
 */
export async function readOpenAiChatGptUsageLimit(
  owner: OpenAiChatGptOwner,
  now: number = Date.now()
): Promise<OpenAiChatGptRecordedUsageLimit | null> {
  const rows = await db
    .select({
      usage_limit_reached_at: openai_chatgpt_connections.usage_limit_reached_at,
      usage_limit_resets_at: openai_chatgpt_connections.usage_limit_resets_at,
      usage_limit_error_code: openai_chatgpt_connections.usage_limit_error_code,
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
    code: row.usage_limit_error_code,
  };
}

/**
 * Holds the owner's row lock and runs `write` only while the stored connection
 * still holds `accessToken`, the credential that served the request which
 * produced the report.
 *
 * A request resolves its token, then the response arrives later. A reconnect in
 * between replaces the credential and rewrites the row, so an owner-scoped write
 * would land on a connection that never reported anything. A missing row is a
 * no-op: the connection was disconnected while the request was in flight, and
 * recreating the row would resurrect a credential nobody owns.
 */
async function withConnectionHoldingToken(
  owner: OpenAiChatGptOwner,
  accessToken: string,
  write: (tx: OpenAiChatGptDatabase, connection: OpenAiChatGptConnection) => Promise<void>,
  options: { onlyWithUsageLimit?: boolean } = {}
): Promise<void> {
  await db.transaction(async tx => {
    const row = await readOpenAiChatGptConnectionRow(tx, owner, {
      forUpdate: true,
      onlyWithUsageLimit: options.onlyWithUsageLimit,
    });
    if (!row) return;
    // Decrypting may wait on the KMS service while the lock is held; the data key cache
    // usually answers, since the request that produced this report read the same row.
    let connection: OpenAiChatGptConnection | null;
    try {
      connection = await decryptOpenAiChatGptConnection(row);
    } catch (error) {
      // Without the payload the report cannot be matched to the credential that produced
      // it, and writing it anyway could land on a connection made since. During a KMS outage
      // routing cannot open the connection either, so no request is served through it.
      if (!(error instanceof CredentialKmsError)) throw error;
      console.error(
        '[openai-chatgpt] report not applied: stored connection unreadable: %s (%s)',
        error.causeName,
        openAiChatGptOwnerKey(owner)
      );
      return;
    }
    if (!connection || connection.access_token !== accessToken) return;
    await write(tx, connection);
  });
}

/**
 * Records the plan limit OpenAI reported on a delegated request. The report is
 * applied only while `accessToken` is still the owner's stored credential: once
 * a reconnect has replaced it and cleared the recorded limit, a late report from
 * the replaced credential must not restore a limit the fresh connection never
 * reported.
 */
export async function recordOpenAiChatGptUsageLimit(
  owner: OpenAiChatGptOwner,
  accessToken: string,
  limit: ChatGptUsageLimit
): Promise<void> {
  await withConnectionHoldingToken(owner, accessToken, async tx => {
    await tx
      .update(openai_chatgpt_connections)
      .set({
        usage_limit_reached_at: new Date().toISOString(),
        usage_limit_resets_at:
          limit.resetsAt === null ? null : new Date(limit.resetsAt).toISOString(),
        usage_limit_error_code: limit.code,
      })
      .where(openAiChatGptOwnerWhere(owner));
  });
}

/**
 * Clears the recorded plan limit after a delegated request succeeded on that
 * connection. OpenAI reports no reset time for an app-specific weekly limit,
 * and a reset a person applies in ChatGPT restores the allowance before the
 * recorded window ends, so a request that reached OpenAI and succeeded is the
 * only signal that proves the limit no longer applies. Waiting for the recorded
 * window instead would keep the notice up after the person can work again.
 *
 * Almost every success finds nothing to clear, so the common case must not take
 * the owner's row lock: parallel requests of one person would queue on it. An
 * unlocked read skips the transaction when the row records no limit. It reads
 * the replica: a stale replica that still shows a cleared limit only falls
 * through to the locked path, which re-checks on the primary; one that misses a
 * limit recorded moments ago skips this clear, and the next success clears it.
 * The locked read matches only a row that records a limit, so even the locked
 * path never locks a row without one.
 *
 * The report is applied only while `accessToken` is still the owner's stored
 * credential, so a late success from a replaced credential cannot drop the limit
 * its own connection recorded.
 */
export async function clearOpenAiChatGptUsageLimit(
  owner: OpenAiChatGptOwner,
  accessToken: string
): Promise<void> {
  try {
    const recorded = await readDb
      .select({ usage_limit_reached_at: openai_chatgpt_connections.usage_limit_reached_at })
      .from(openai_chatgpt_connections)
      .where(openAiChatGptOwnerWhere(owner))
      .limit(1);
    if (!recorded[0]?.usage_limit_reached_at) return;
  } catch (error) {
    // An unavailable replica must not disable clearing: the locked path below
    // re-checks on the primary, exactly as before the pre-check existed.
    console.debug(
      '[openai-chatgpt] usage limit pre-check failed, falling back to the primary: %s',
      error instanceof Error ? error.name : 'UnknownError'
    );
  }

  await withConnectionHoldingToken(
    owner,
    accessToken,
    async tx => {
      await tx
        .update(openai_chatgpt_connections)
        .set({ ...NO_USAGE_LIMIT })
        .where(openAiChatGptOwnerWhere(owner));
    },
    { onlyWithUsageLimit: true }
  );
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
 * `sealingKey` is created before that lock is taken.
 */
export async function markOpenAiChatGptConnectionErrored(
  fromDb: OpenAiChatGptDatabase,
  owner: OpenAiChatGptOwner,
  connection: OpenAiChatGptConnection,
  message: string,
  sealingKey: OpenAiChatGptSealingKey
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
    .set({ ...sealOpenAiChatGptConnection(errored, sealingKey), is_enabled: false })
    .where(openAiChatGptOwnerWhere(owner));
}

/**
 * Records OpenAI's refusal of the connected account. Only the connection whose
 * access token served the refused request is marked: a reconnect that landed
 * while the request was in flight can hold a different, eligible account, and
 * must not be erased by a stale refusal. A missing row is a no-op.
 */
export async function markOpenAiChatGptNotEligible(
  owner: OpenAiChatGptOwner,
  refusedAccessToken: string,
  message: string
): Promise<void> {
  const sealingKey = await createOpenAiChatGptConnectionSealingKey(
    owner,
    OPENAI_CHATGPT_ELIGIBILITY_KMS_ACTOR
  ).catch((error: unknown) => {
    console.error(
      '[openai-chatgpt] no data key for the refusal; dropping the refused credential: %s (%s)',
      error instanceof Error ? error.name : 'UnknownError',
      openAiChatGptOwnerKey(owner)
    );
    return null;
  });
  await withConnectionHoldingToken(owner, refusedAccessToken, async (tx, connection) => {
    if (sealingKey) {
      await markOpenAiChatGptConnectionErrored(tx, owner, connection, message, sealingKey);
      return;
    }
    // A refusal that cannot be sealed must still stop the account serving requests, so the
    // refused tokens are removed and the row disabled. The row then reads as disconnected
    // rather than showing the refusal reason.
    await tx
      .update(openai_chatgpt_connections)
      .set({ ...CLEARED_OPENAI_CHATGPT_CONNECTION_PAYLOAD, is_enabled: false })
      .where(openAiChatGptOwnerWhere(owner));
  });
}
