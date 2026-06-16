import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { BYOK_ENCRYPTION_KEY } from '@/lib/config.server';
import { encryptWithSymmetricKey, decryptWithSymmetricKey } from '@/lib/encryption';
import {
  kiloclaw_agentcard_oauth_connections,
  type KiloClawAgentCardOAuthConnection,
  type KiloClawAgentCardOAuthStatus,
} from '@kilocode/db/schema';
import type { AgentCardTokenSet } from '@/lib/integrations/agentcard/agentcard-service';

function encryptToken(value: string): string {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  return encryptWithSymmetricKey(value, BYOK_ENCRYPTION_KEY);
}

function decryptToken(value: string): string {
  if (!BYOK_ENCRYPTION_KEY) {
    throw new Error('BYOK_ENCRYPTION_KEY is not configured');
  }
  return decryptWithSymmetricKey(value, BYOK_ENCRYPTION_KEY);
}

type UpsertInput = {
  instanceId: string;
  oauthClientId: string;
  tokens: AgentCardTokenSet;
  accountEmail?: string | null;
};

export async function upsertKiloClawAgentCardOAuthConnection(
  input: UpsertInput
): Promise<KiloClawAgentCardOAuthConnection> {
  const now = new Date().toISOString();
  const accessTokenEncrypted = encryptToken(input.tokens.accessToken);
  const refreshTokenEncrypted = input.tokens.refreshToken
    ? encryptToken(input.tokens.refreshToken)
    : null;
  const status: KiloClawAgentCardOAuthStatus = 'active';

  await db
    .insert(kiloclaw_agentcard_oauth_connections)
    .values({
      instance_id: input.instanceId,
      provider: 'agentcard',
      account_email: input.accountEmail ?? null,
      oauth_client_id: input.oauthClientId,
      access_token_encrypted: accessTokenEncrypted,
      refresh_token_encrypted: refreshTokenEncrypted,
      token_expires_at: input.tokens.expiresAt,
      scopes: input.tokens.scopes,
      status,
      last_error: null,
      last_error_at: null,
      connected_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: kiloclaw_agentcard_oauth_connections.instance_id,
      set: {
        account_email: input.accountEmail ?? null,
        oauth_client_id: input.oauthClientId,
        access_token_encrypted: accessTokenEncrypted,
        // Keep the existing refresh token if the refresh response omitted one.
        ...(refreshTokenEncrypted ? { refresh_token_encrypted: refreshTokenEncrypted } : {}),
        token_expires_at: input.tokens.expiresAt,
        scopes: input.tokens.scopes,
        status,
        last_error: null,
        last_error_at: null,
        connected_at: now,
        updated_at: now,
      },
    });

  const row = await getKiloClawAgentCardOAuthConnection(input.instanceId);
  if (!row) {
    throw new Error('AgentCard OAuth connection row missing after upsert');
  }
  return row;
}

export async function getKiloClawAgentCardOAuthConnection(
  instanceId: string
): Promise<KiloClawAgentCardOAuthConnection | null> {
  const [row] = await db
    .select()
    .from(kiloclaw_agentcard_oauth_connections)
    .where(
      and(
        eq(kiloclaw_agentcard_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_agentcard_oauth_connections.provider, 'agentcard')
      )
    )
    .limit(1);

  return row ?? null;
}

export async function clearKiloClawAgentCardOAuthConnection(instanceId: string): Promise<void> {
  await db
    .delete(kiloclaw_agentcard_oauth_connections)
    .where(
      and(
        eq(kiloclaw_agentcard_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_agentcard_oauth_connections.provider, 'agentcard')
      )
    );
}

export async function setKiloClawAgentCardOAuthConnectionError(
  instanceId: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .update(kiloclaw_agentcard_oauth_connections)
    .set({
      status: 'action_required',
      last_error: message,
      last_error_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(kiloclaw_agentcard_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_agentcard_oauth_connections.provider, 'agentcard')
      )
    );
}

/** Decrypt the stored refresh token, if any. */
export function decryptRefreshToken(connection: KiloClawAgentCardOAuthConnection): string | null {
  return connection.refresh_token_encrypted
    ? decryptToken(connection.refresh_token_encrypted)
    : null;
}

/** Decrypt the stored access token. */
export function decryptAccessToken(connection: KiloClawAgentCardOAuthConnection): string {
  return decryptToken(connection.access_token_encrypted);
}

/**
 * Optimistically claim a connection for refresh so two overlapping sweeps don't
 * both refresh the same row. AgentCard rotates refresh tokens (each refresh
 * invalidates the previous one), so a concurrent double-refresh would make one
 * side fail and needlessly flip the connection to `action_required`.
 *
 * Bumps `updated_at` only if it still matches what the caller read; the row
 * lock makes this atomic, so exactly one concurrent caller gets `true`.
 */
export async function claimAgentCardConnectionForRefresh(
  connection: KiloClawAgentCardOAuthConnection
): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const claimed = await db
    .update(kiloclaw_agentcard_oauth_connections)
    .set({ updated_at: claimedAt })
    .where(
      and(
        eq(kiloclaw_agentcard_oauth_connections.id, connection.id),
        eq(kiloclaw_agentcard_oauth_connections.updated_at, connection.updated_at)
      )
    )
    .returning({ id: kiloclaw_agentcard_oauth_connections.id });
  return claimed.length === 1;
}
