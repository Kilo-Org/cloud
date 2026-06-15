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
import {
  refreshAgentCardToken,
  type AgentCardTokenSet,
} from '@/lib/integrations/agentcard/agentcard-service';

// Refresh the access token when it expires within this window so the worker is
// never handed a token that's about to die.
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

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

/**
 * Returns a valid (non-expired) access token for the connection's instance,
 * refreshing via AgentCard if it's within the refresh buffer of expiry. On
 * refresh failure the connection is marked `action_required` and the error is
 * rethrown so callers can surface a reconnect prompt.
 *
 * AgentCard access tokens are short-lived (~1h); the OpenClaw gateway hits the
 * MCP server directly with a static Bearer header, so the web app must keep a
 * fresh token in the worker secret. Call this before pushing to the worker.
 */
export async function getValidAgentCardAccessToken(
  connection: KiloClawAgentCardOAuthConnection
): Promise<string> {
  const expiresAt = connection.token_expires_at
    ? new Date(connection.token_expires_at).getTime()
    : null;
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() <= REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return decryptToken(connection.access_token_encrypted);
  }

  const refreshToken = decryptRefreshToken(connection);
  if (!refreshToken) {
    // No refresh token — return the (possibly stale) access token; the worker
    // call will fail and the user can reconnect.
    return decryptToken(connection.access_token_encrypted);
  }

  try {
    const tokens = await refreshAgentCardToken({
      refreshToken,
      clientId: connection.oauth_client_id,
    });
    const updated = await upsertKiloClawAgentCardOAuthConnection({
      instanceId: connection.instance_id,
      oauthClientId: connection.oauth_client_id,
      tokens,
      accountEmail: connection.account_email,
    });
    return decryptToken(updated.access_token_encrypted);
  } catch (error) {
    await setKiloClawAgentCardOAuthConnectionError(
      connection.instance_id,
      error instanceof Error ? error.message : 'AgentCard token refresh failed'
    );
    throw error;
  }
}
