import 'server-only';
import { z } from 'zod';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { DOLTHUB_APP_DEV_CLIENT_ID, DOLTHUB_APP_DEV_CLIENT_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';

const DOLTHUB_TOKEN_URL = 'https://www.dolthub.com/api/oauth/access_token';
const DOLTHUB_AUTHORIZE_URL = 'https://www.dolthub.com/oauth/authorize';

function assertDevOnly(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DoltHub integration is dev-only and not available in production');
  }
}

function getOwnershipConditions(owner: Owner) {
  return owner.type === 'user'
    ? [
        eq(platform_integrations.owned_by_user_id, owner.id),
        isNull(platform_integrations.owned_by_organization_id),
      ]
    : [
        eq(platform_integrations.owned_by_organization_id, owner.id),
        isNull(platform_integrations.owned_by_user_id),
      ];
}

export const DOLTHUB_SCOPES = ['api_read_write'];

/**
 * Redirect URI for the DoltHub OAuth flow.
 *
 * This MUST resolve to `http://localhost:3000/api/integrations/dolthub/callback`
 * for the current registered DoltHub app. DoltHub only allows `https://` and
 * `http://localhost/...` redirect URIs, and self-service mutation is not yet
 * available. If a developer sets `APP_URL_OVERRIDE` (ngrok, etc.) they will
 * need DoltHub admins to register the additional URI.
 */
export const DOLTHUB_REDIRECT_URI = `${APP_URL}/api/integrations/dolthub/callback`;

export function getDoltHubOAuthUrl(state: string): string {
  assertDevOnly();

  const params = new URLSearchParams({
    client_id: DOLTHUB_APP_DEV_CLIENT_ID,
    response_type: 'code',
    scope: DOLTHUB_SCOPES.join(','),
    redirect_uri: DOLTHUB_REDIRECT_URI,
    state,
  });

  return `${DOLTHUB_AUTHORIZE_URL}?${params.toString()}`;
}

export type DoltHubTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
};

const DoltHubTokenPayloadSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
  scope: z.string().optional(),
});

function parseDoltHubTokenPayload(
  raw: unknown,
  operation: 'exchange' | 'refresh'
): DoltHubTokenResponse {
  const parseResult = DoltHubTokenPayloadSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(`DoltHub token ${operation} returned invalid payload`);
  }
  const parsed = parseResult.data;
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? null,
    expiresIn: parsed.expires_in ?? null,
    scope: parsed.scope ?? null,
  };
}

export async function exchangeDoltHubOAuthCode(code: string): Promise<DoltHubTokenResponse> {
  assertDevOnly();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: DOLTHUB_REDIRECT_URI,
  });

  const response = await fetch(DOLTHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${DOLTHUB_APP_DEV_CLIENT_ID}:${DOLTHUB_APP_DEV_CLIENT_SECRET}`)}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`DoltHub token exchange failed: ${response.status} ${response.statusText}`);
  }

  return parseDoltHubTokenPayload(await response.json(), 'exchange');
}

export async function refreshDoltHubAccessToken(
  refreshToken: string
): Promise<DoltHubTokenResponse> {
  assertDevOnly();

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: DOLTHUB_REDIRECT_URI,
  });

  const response = await fetch(DOLTHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${DOLTHUB_APP_DEV_CLIENT_ID}:${DOLTHUB_APP_DEV_CLIENT_SECRET}`)}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`DoltHub token refresh failed: ${response.status} ${response.statusText}`);
  }

  return parseDoltHubTokenPayload(await response.json(), 'refresh');
}

export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  assertDevOnly();

  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.DOLTHUB))
    )
    .orderBy(sql`${platform_integrations.updated_at} DESC`)
    .limit(1);

  return integration || null;
}

export async function upsertDoltHubInstallation({
  owner,
  tokens,
}: {
  owner: Owner;
  tokens: DoltHubTokenResponse;
}): Promise<PlatformIntegration> {
  assertDevOnly();

  const expiresAt = tokens.expiresIn ? Date.now() + tokens.expiresIn * 1000 : null;

  const metadata = {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expires_at: expiresAt,
    scope: tokens.scope,
  };

  // The synthetic platform_installation_id makes the existing partial unique
  // indexes UQ_platform_integrations_owned_by_(user|org)_platform_inst apply
  // here, so we can let Postgres atomically resolve concurrent OAuth
  // completions instead of racing in the old select-then-insert path.
  const platformInstallationId = `dolthub-${owner.type}-${owner.id}`;

  const updateSet = {
    scopes: DOLTHUB_SCOPES,
    integration_status: INTEGRATION_STATUS.ACTIVE,
    metadata,
    updated_at: new Date().toISOString(),
  };

  const onConflict =
    owner.type === 'user'
      ? {
          target: [
            platform_integrations.owned_by_user_id,
            platform_integrations.platform,
            platform_integrations.platform_installation_id,
          ],
          targetWhere: sql`${platform_integrations.owned_by_user_id} IS NOT NULL`,
          set: updateSet,
        }
      : {
          target: [
            platform_integrations.owned_by_organization_id,
            platform_integrations.platform,
            platform_integrations.platform_installation_id,
          ],
          targetWhere: sql`${platform_integrations.owned_by_organization_id} IS NOT NULL`,
          set: updateSet,
        };

  const [upserted] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'org' ? owner.id : null,
      platform: PLATFORM.DOLTHUB,
      integration_type: 'oauth',
      platform_installation_id: platformInstallationId,
      scopes: DOLTHUB_SCOPES,
      integration_status: INTEGRATION_STATUS.ACTIVE,
      metadata,
      installed_at: new Date().toISOString(),
    })
    .onConflictDoUpdate(onConflict)
    .returning();

  if (!upserted) {
    throw new Error('DoltHub installation upsert returned no rows');
  }

  return upserted;
}

export async function uninstall(owner: Owner): Promise<{ success: boolean }> {
  assertDevOnly();

  const ownershipConditions = getOwnershipConditions(owner);

  await db
    .delete(platform_integrations)
    .where(and(...ownershipConditions, eq(platform_integrations.platform, PLATFORM.DOLTHUB)));

  return { success: true };
}

export async function getValidDoltHubToken(
  integration: PlatformIntegration
): Promise<string | null> {
  assertDevOnly();

  const metadata = integration.metadata as {
    access_token?: string;
    refresh_token?: string;
    expires_at?: number;
    scope?: string;
  } | null;

  if (!metadata?.access_token) {
    return null;
  }

  // When expires_at is missing/null the token is treated as non-expiring
  // (DoltHub issues long-lived tokens that do not include expires_in).
  if (metadata.expires_at && Date.now() >= metadata.expires_at) {
    if (!metadata.refresh_token) {
      return null;
    }

    const newTokens = await refreshDoltHubAccessToken(metadata.refresh_token);
    const newExpiresAt = newTokens.expiresIn ? Date.now() + newTokens.expiresIn * 1000 : null;

    // OAuth refresh responses may omit refresh_token / scope, in which case
    // RFC 6749 says the previous values remain valid. Falling back here
    // prevents overwriting a still-good refresh_token (or scope) with null.
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...metadata,
          access_token: newTokens.accessToken,
          refresh_token: newTokens.refreshToken ?? metadata.refresh_token,
          expires_at: newExpiresAt,
          scope: newTokens.scope ?? metadata.scope,
        },
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    return newTokens.accessToken;
  }

  return metadata.access_token;
}
