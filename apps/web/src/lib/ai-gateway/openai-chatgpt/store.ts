import 'server-only';

import { and, eq } from 'drizzle-orm';
import { byok_api_keys } from '@kilocode/db/schema';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import { decryptApiKey, encryptApiKey, type EncryptedData } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { OPENAI_CHATGPT_PROVIDER_ID } from './provider-id';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

/**
 * The delegated "Sign in with ChatGPT" tokens are the OpenAI BYOK credential.
 * They live in `byok_api_keys` under the dedicated `openai-chatgpt` provider id,
 * encrypted with the same AES-256-GCM helpers as every other BYOK key and
 * upserted on the table's `(kilo_user_id, provider_id)` unique constraint.
 */

/** Either the primary database or an open transaction. */
export type OpenAiChatGptDatabase = typeof db | DrizzleTransaction;

/**
 * Reads the raw connection row. `options.forUpdate` takes a `SELECT ... FOR
 * UPDATE` row lock, used inside a transaction so a concurrent refresh in
 * another process cannot interleave.
 */
export async function readOpenAiChatGptConnectionRow(
  fromDb: OpenAiChatGptDatabase,
  userId: string,
  options: { forUpdate?: boolean } = {}
) {
  const query = fromDb
    .select({ encrypted_api_key: byok_api_keys.encrypted_api_key })
    .from(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
      )
    );

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
  userId: string
): Promise<OpenAiChatGptConnection | null> {
  const row = await readOpenAiChatGptConnectionRow(db, userId);
  return row ? decryptOpenAiChatGptConnection(row.encrypted_api_key) : null;
}

/**
 * Inserts or replaces the connection for a user. The upsert targets the
 * `(kilo_user_id, provider_id)` unique constraint, so reconnecting never leaves
 * a second row behind. `organization_id` is null (the connection is personal),
 * and the row is always left enabled and connected with any previous error
 * state cleared.
 */
export async function saveOpenAiChatGptConnection(
  userId: string,
  connection: OpenAiChatGptConnection
): Promise<void> {
  const stored: OpenAiChatGptConnection = {
    ...connection,
    status: 'connected',
    error_message: undefined,
    error_at: undefined,
  };
  const encrypted_api_key = encryptApiKey(JSON.stringify(stored), BYOK_ENCRYPTION_KEY);
  const values = {
    organization_id: null,
    kilo_user_id: userId,
    provider_id: OPENAI_CHATGPT_PROVIDER_ID,
    encrypted_api_key,
    management_source: 'user' as const,
    is_enabled: true,
    created_by: userId,
  };

  await db
    .insert(byok_api_keys)
    .values(values)
    .onConflictDoUpdate({
      target: [byok_api_keys.kilo_user_id, byok_api_keys.provider_id],
      set: {
        encrypted_api_key,
        is_enabled: true,
      },
    });
}

/** Deletes the stored connection, for example when the account is unlinked. */
export async function clearOpenAiChatGptConnection(userId: string): Promise<void> {
  await db
    .delete(byok_api_keys)
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
      )
    );
}

/**
 * Records a terminal connection failure while keeping the tokens: the row is
 * disabled so no request retries it, and the status tells the UI to show the
 * reconnect message. A missing row is a no-op.
 */
export async function markOpenAiChatGptError(userId: string, message: string): Promise<void> {
  const connection = await getOpenAiChatGptConnection(userId);
  if (!connection) return;

  const errored: OpenAiChatGptConnection = {
    ...connection,
    status: 'error',
    error_message: message,
    error_at: new Date().toISOString(),
  };

  await db
    .update(byok_api_keys)
    .set({
      encrypted_api_key: encryptApiKey(JSON.stringify(errored), BYOK_ENCRYPTION_KEY),
      is_enabled: false,
    })
    .where(
      and(
        eq(byok_api_keys.kilo_user_id, userId),
        eq(byok_api_keys.provider_id, OPENAI_CHATGPT_PROVIDER_ID)
      )
    );
}
