import 'server-only';

import { and, eq, type SQL } from 'drizzle-orm';
import { byok_api_keys } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { decryptApiKey, encryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { OPENAI_CHATGPT_PROVIDER_ID } from './provider-id';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

/**
 * The delegated "Sign in with ChatGPT" tokens are the OpenAI BYOK credential.
 * They live in `byok_api_keys` under the dedicated `openai-chatgpt` provider id,
 * encrypted with the same AES-256-GCM helpers as every other BYOK key. A
 * connection is owned by exactly one account: a person or an organization, one
 * connection per owner.
 */

/** The account a connection belongs to. */
export type OpenAiChatGptOwner = { type: 'user'; id: string } | { type: 'org'; id: string };

/** Stable identity for per-owner state such as the in-flight refresh map. */
export function openAiChatGptOwnerKey(owner: OpenAiChatGptOwner): string {
  return `${owner.type}:${owner.id}`;
}

function ownerCondition(owner: OpenAiChatGptOwner): SQL {
  return owner.type === 'org'
    ? eq(byok_api_keys.organization_id, owner.id)
    : eq(byok_api_keys.kilo_user_id, owner.id);
}

/** Matches the owner's `openai-chatgpt` row for reads, updates and deletes. */
export function openAiChatGptConnectionWhere(owner: OpenAiChatGptOwner): SQL | undefined {
  return and(ownerCondition(owner), eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID));
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
      encrypted_api_key: byok_api_keys.encrypted_api_key,
      is_enabled: byok_api_keys.is_enabled,
    })
    .from(byok_api_keys)
    .where(openAiChatGptConnectionWhere(owner));

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
  return row ? decryptOpenAiChatGptConnection(row.encrypted_api_key) : null;
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
  const connection = decryptOpenAiChatGptConnection(row.encrypted_api_key);
  return connection ? { connection, isEnabled: row.is_enabled } : null;
}

/**
 * Inserts or replaces the owner's connection. The upsert targets the owner's
 * unique constraint, so reconnecting never leaves a second row behind. The row
 * is always left enabled and connected with any previous error state cleared.
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
  const encrypted_api_key = encryptApiKey(JSON.stringify(stored), BYOK_ENCRYPTION_KEY);
  const values = {
    organization_id: owner.type === 'org' ? owner.id : null,
    kilo_user_id: owner.type === 'user' ? owner.id : null,
    provider_id: OPENAI_CHATGPT_PROVIDER_ID,
    encrypted_api_key,
    management_source: 'user' as const,
    is_enabled: true,
    created_by: createdBy,
  };

  await db
    .insert(byok_api_keys)
    .values(values)
    .onConflictDoUpdate({
      target:
        owner.type === 'org'
          ? [byok_api_keys.organization_id, byok_api_keys.provider_id]
          : [byok_api_keys.kilo_user_id, byok_api_keys.provider_id],
      set: {
        encrypted_api_key,
        is_enabled: true,
      },
    });
}

/** Deletes the owner's stored connection. */
export async function clearOpenAiChatGptConnection(owner: OpenAiChatGptOwner): Promise<void> {
  await db.delete(byok_api_keys).where(openAiChatGptConnectionWhere(owner));
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
    .update(byok_api_keys)
    .set({
      encrypted_api_key: encryptApiKey(JSON.stringify(errored), BYOK_ENCRYPTION_KEY),
      is_enabled: false,
    })
    .where(openAiChatGptConnectionWhere(owner));
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
