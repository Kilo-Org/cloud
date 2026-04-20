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

type GrantsBySource = {
  legacy?: string[];
  oauth?: string[];
};

function normalizeCapabilities(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort();
}

function deriveGrantsBySource(
  existing: {
    credential_profile: 'legacy' | 'kilo_owned';
    capabilities: string[];
    grants_by_source?: GrantsBySource | null;
  } | null,
  oauthCapabilities: readonly string[]
): GrantsBySource {
  const nextOauth = normalizeCapabilities(oauthCapabilities);
  const existingGrants = existing?.grants_by_source ?? {};
  const nextLegacy = normalizeCapabilities([
    ...(existingGrants.legacy ?? []),
    ...(existing?.credential_profile === 'legacy' ? (existing.capabilities ?? []) : []),
  ]);

  const grants: GrantsBySource = {};
  if (nextLegacy.length > 0) grants.legacy = nextLegacy;
  if (nextOauth.length > 0) grants.oauth = nextOauth;
  return grants;
}

function effectiveCapabilitiesFromGrants(grants: GrantsBySource): string[] {
  return normalizeCapabilities([...(grants.legacy ?? []), ...(grants.oauth ?? [])]);
}

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
  const oauthCapabilities = normalizeCapabilities(input.capabilities);

  const [existing] = await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, input.instanceId))
    .limit(1);

  let encryptedRefreshToken = input.refreshToken
    ? encryptRefreshToken(input.refreshToken)
    : (existing?.refresh_token_encrypted ?? null);

  if (!existing && !encryptedRefreshToken) {
    const [concurrentWinner] = await db
      .select()
      .from(kiloclaw_google_oauth_connections)
      .where(eq(kiloclaw_google_oauth_connections.instance_id, input.instanceId))
      .limit(1);
    encryptedRefreshToken = concurrentWinner?.refresh_token_encrypted ?? null;
  }

  if (!encryptedRefreshToken) {
    throw new Error(
      'Google OAuth response did not include a refresh token and no stored token exists for this instance'
    );
  }

  if (existing) {
    const nextStatus: KiloClawGoogleOAuthStatus = 'active';
    const grantsBySource = deriveGrantsBySource(existing, oauthCapabilities);
    const effectiveCapabilities = effectiveCapabilitiesFromGrants(grantsBySource);
    const shouldUpdateConnectedAt =
      existing.status !== 'active' ||
      !equalSortedLists(existing.capabilities ?? [], effectiveCapabilities) ||
      !equalSortedLists(existing.scopes ?? [], nextScopes);

    await db
      .update(kiloclaw_google_oauth_connections)
      .set({
        account_email: input.accountEmail,
        account_subject: input.accountSubject,
        oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
        oauth_client_secret_encrypted: null,
        credential_profile: 'kilo_owned',
        refresh_token_encrypted: encryptedRefreshToken,
        scopes: nextScopes,
        grants_by_source: grantsBySource,
        capabilities: effectiveCapabilities,
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
      capabilities: effectiveCapabilities,
    };
  }

  const status: KiloClawGoogleOAuthStatus = 'active';
  const grantsBySource: GrantsBySource = {
    oauth: oauthCapabilities,
  };
  const effectiveCapabilities = effectiveCapabilitiesFromGrants(grantsBySource);
  await db
    .insert(kiloclaw_google_oauth_connections)
    .values({
      instance_id: input.instanceId,
      provider: 'google',
      account_email: input.accountEmail,
      account_subject: input.accountSubject,
      oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
      oauth_client_secret_encrypted: null,
      credential_profile: 'kilo_owned',
      refresh_token_encrypted: encryptedRefreshToken,
      scopes: nextScopes,
      grants_by_source: grantsBySource,
      capabilities: effectiveCapabilities,
      status,
      connected_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: kiloclaw_google_oauth_connections.instance_id,
      set: {
        account_email: input.accountEmail,
        account_subject: input.accountSubject,
        oauth_client_id: GOOGLE_WORKSPACE_OAUTH_CLIENT_ID,
        oauth_client_secret_encrypted: null,
        credential_profile: 'kilo_owned',
        refresh_token_encrypted: encryptedRefreshToken,
        scopes: nextScopes,
        status,
        last_error: null,
        last_error_at: null,
        connected_at: now,
        updated_at: now,
      },
    });

  const [current] = await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(eq(kiloclaw_google_oauth_connections.instance_id, input.instanceId))
    .limit(1);

  if (!current) {
    throw new Error('Google OAuth connection row missing after insert/upsert');
  }

  const mergedGrantsBySource = deriveGrantsBySource(current, oauthCapabilities);
  const mergedEffectiveCapabilities = effectiveCapabilitiesFromGrants(mergedGrantsBySource);
  const shouldUpdateConnectedAt =
    current.status !== 'active' ||
    !equalSortedLists(current.capabilities ?? [], mergedEffectiveCapabilities) ||
    !equalSortedLists(current.scopes ?? [], nextScopes);

  await db
    .update(kiloclaw_google_oauth_connections)
    .set({
      grants_by_source: mergedGrantsBySource,
      capabilities: mergedEffectiveCapabilities,
      connected_at: shouldUpdateConnectedAt ? now : current.connected_at,
      updated_at: now,
    })
    .where(eq(kiloclaw_google_oauth_connections.id, current.id));

  return {
    status,
    accountEmail: input.accountEmail,
    scopes: nextScopes,
    capabilities: mergedEffectiveCapabilities,
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

export async function getKiloClawGoogleOAuthConnection(instanceId: string) {
  const [row] = await db
    .select()
    .from(kiloclaw_google_oauth_connections)
    .where(
      and(
        eq(kiloclaw_google_oauth_connections.instance_id, instanceId),
        eq(kiloclaw_google_oauth_connections.provider, 'google')
      )
    )
    .limit(1);

  return row ?? null;
}
