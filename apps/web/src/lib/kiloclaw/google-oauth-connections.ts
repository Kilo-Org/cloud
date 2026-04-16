import 'server-only';

import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
  GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY,
} from '@/lib/config.server';
import { encryptWithSymmetricKey } from '@/lib/encryption';
import {
  kiloclaw_google_oauth_connections,
  type KiloClawGoogleOAuthStatus,
} from '@kilocode/db/schema';
import type { GoogleCapability } from '@/lib/integrations/google/capabilities';

type UpsertKiloClawGoogleOAuthConnectionInput = {
  instanceId: string;
  accountEmail: string;
  accountSubject: string;
  refreshToken: string | null;
  scopes: string[];
  capabilities: GoogleCapability[];
};

function encryptRefreshToken(refreshToken: string): string {
  if (!GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY) {
    throw new Error('GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY is not configured');
  }

  return encryptWithSymmetricKey(refreshToken, GOOGLE_WORKSPACE_REFRESH_TOKEN_ENCRYPTION_KEY);
}

function equalSortedLists(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export async function upsertKiloClawGoogleOAuthConnection(
  input: UpsertKiloClawGoogleOAuthConnectionInput
): Promise<{
  status: KiloClawGoogleOAuthStatus;
  accountEmail: string;
  scopes: string[];
  capabilities: string[];
}> {
  const now = new Date().toISOString();
  const nextScopes = [...new Set(input.scopes)].sort();
  const nextCapabilities = [...new Set(input.capabilities)].sort();

  const [existing] = await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, input.instanceId))
    .limit(1);

  const existingEncryptedRefreshToken = existing?.refresh_token_encrypted ?? null;

  const encryptedRefreshToken = input.refreshToken
    ? encryptRefreshToken(input.refreshToken)
    : existingEncryptedRefreshToken;

  if (!encryptedRefreshToken) {
    throw new Error(
      'Google OAuth response did not include a refresh token and no stored token exists for this instance'
    );
  }

  if (existing) {
    const nextStatus: KiloClawGoogleOAuthStatus = 'active';
    const shouldUpdateConnectedAt =
      existing.status !== 'active' ||
      !equalSortedLists(existing.capabilities ?? [], nextCapabilities) ||
      !equalSortedLists(existing.scopes ?? [], nextScopes);

    await db
      .update(kiloclaw_google_oauth_connections)
      .set({
        account_email: input.accountEmail,
        account_subject: input.accountSubject,
        oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
        refresh_token_encrypted: encryptedRefreshToken,
        scopes: nextScopes,
        capabilities: nextCapabilities,
        status: nextStatus,
        last_error: null,
        last_error_at: null,
        connected_at: shouldUpdateConnectedAt ? now : existing.connected_at,
        updated_at: now,
      })
      .where(eq(kiloclaw_google_oauth_connections.id, existing.id));

    return {
      status: nextStatus,
      accountEmail: input.accountEmail,
      scopes: nextScopes,
      capabilities: nextCapabilities,
    };
  }

  const status: KiloClawGoogleOAuthStatus = 'active';
  await db.insert(kiloclaw_google_oauth_connections).values({
    instance_id: input.instanceId,
    provider: 'google',
    account_email: input.accountEmail,
    account_subject: input.accountSubject,
    oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
    refresh_token_encrypted: encryptedRefreshToken,
    scopes: nextScopes,
    capabilities: nextCapabilities,
    status,
    connected_at: now,
    created_at: now,
    updated_at: now,
  });

  return {
    status,
    accountEmail: input.accountEmail,
    scopes: nextScopes,
    capabilities: nextCapabilities,
  };
}

export async function setKiloClawGoogleOAuthConnectionError(
  instanceId: string,
  message: string
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .update(kiloclaw_google_oauth_connections)
    .set({
      status: 'action_required',
      last_error: message,
      last_error_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(kiloclaw_google_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_google_oauth_connections.provider, 'google')
      )
    );
}

export async function clearKiloClawGoogleOAuthConnection(instanceId: string): Promise<void> {
  await db
    .delete(kiloclaw_google_oauth_connections)
    .where(
      and(
        eq(kiloclaw_google_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_google_oauth_connections.provider, 'google')
      )
    );
}
