import 'server-only';
import { z } from 'zod';
import { captureMessage } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { DOLTHUB_APP_CLIENT_ID, DOLTHUB_APP_CLIENT_SECRET } from '@/lib/config.server';

const DOLTHUB_TOKEN_URL = 'https://www.dolthub.com/api/oauth/access_token';
const DOLTHUB_AUTHORIZE_URL = 'https://www.dolthub.com/oauth/authorize';
const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';

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
export const DOLTHUB_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.DOLTHUB);

export function getDoltHubOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: DOLTHUB_APP_CLIENT_ID,
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
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: DOLTHUB_REDIRECT_URI,
  });

  const response = await fetch(DOLTHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${DOLTHUB_APP_CLIENT_ID}:${DOLTHUB_APP_CLIENT_SECRET}`)}`,
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
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    redirect_uri: DOLTHUB_REDIRECT_URI,
  });

  const response = await fetch(DOLTHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${DOLTHUB_APP_CLIENT_ID}:${DOLTHUB_APP_CLIENT_SECRET}`)}`,
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`DoltHub token refresh failed: ${response.status} ${response.statusText}`);
  }

  return parseDoltHubTokenPayload(await response.json(), 'refresh');
}

export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
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
  const ownershipConditions = getOwnershipConditions(owner);

  await db
    .delete(platform_integrations)
    .where(and(...ownershipConditions, eq(platform_integrations.platform, PLATFORM.DOLTHUB)));

  return { success: true };
}

/**
 * Shape of the JSONB metadata column for a DoltHub integration. The fields
 * mirror the OAuth token-response payload, plus an optional cached
 * `dolthub_username` we resolve via `GET /api/v1alpha1/user` on first use
 * (see {@link getDoltHubUser}). The cache is opportunistic — when the
 * resolver is unavailable for any reason callers can still ask the user
 * to type their username manually and persist it via
 * {@link rememberDoltHubUsername}.
 */
type DoltHubMetadata = {
  access_token?: string;
  refresh_token?: string | null;
  expires_at?: number | null;
  scope?: string | null;
  dolthub_username?: string | null;
};

function readMetadata(integration: PlatformIntegration): DoltHubMetadata {
  return (integration.metadata as DoltHubMetadata | null) ?? {};
}

export async function getValidDoltHubToken(
  integration: PlatformIntegration
): Promise<string | null> {
  const metadata = readMetadata(integration);

  if (!metadata.access_token) {
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
        } satisfies DoltHubMetadata,
        updated_at: new Date().toISOString(),
      })
      .where(eq(platform_integrations.id, integration.id));

    return newTokens.accessToken;
  }

  return metadata.access_token;
}

/**
 * Returns the DoltHub username we've captured for this integration, if any.
 * Captured either via the `/api/v1alpha1/user` resolver in
 * {@link getDoltHubUser} or by user confirmation through
 * {@link rememberDoltHubUsername}.
 */
export function getCachedDoltHubUsername(integration: PlatformIntegration): string | null {
  return readMetadata(integration).dolthub_username ?? null;
}

/**
 * Calls DoltHub's authenticated `GET /api/v1alpha1/user` endpoint to
 * resolve the username associated with the OAuth access token. Returns
 * `null` if the call fails (e.g. revoked token, network error) so callers
 * can fall back to manual entry. The resolved username is cached on the
 * integration metadata so subsequent calls are free.
 */
const DoltHubUserResponse = z
  .object({
    username: z.string().min(1).optional(),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .passthrough();

export async function getDoltHubUser(
  integration: PlatformIntegration
): Promise<{ username: string } | null> {
  const cached = getCachedDoltHubUsername(integration);
  if (cached) return { username: cached };

  const token = await getValidDoltHubToken(integration);
  if (!token) return null;

  let response: Response;
  try {
    response = await fetch(`${DOLTHUB_API_BASE}/user`, {
      headers: { authorization: `token ${token}` },
    });
  } catch (err) {
    // Transport-level failure — DoltHub down, DNS issue, etc. Surface to
    // Sentry so we notice if onboarding starts silently degrading, but
    // return null to let callers fall back to manual username entry.
    captureMessage('DoltHub /user lookup failed (transport)', {
      level: 'warning',
      tags: { source: 'dolthub_resolve_username' },
      extra: { message: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
  if (!response.ok) {
    captureMessage('DoltHub /user lookup returned non-2xx', {
      level: 'warning',
      tags: { source: 'dolthub_resolve_username' },
      extra: { status: response.status },
    });
    return null;
  }

  const parsed = DoltHubUserResponse.safeParse(await response.json().catch(() => null));
  if (!parsed.success || !parsed.data.username) {
    captureMessage('DoltHub /user lookup returned unexpected payload', {
      level: 'warning',
      tags: { source: 'dolthub_resolve_username' },
      extra: { hasUsername: parsed.success && Boolean(parsed.data.username) },
    });
    return null;
  }

  await rememberDoltHubUsername(integration, parsed.data.username);
  return { username: parsed.data.username };
}

/**
 * Probes a DoltHub upstream (`{owner}/{db}`) to confirm it exists. The
 * probe runs in up to two stages:
 *
 * 1. **Public probe** — unauthenticated `SELECT 1` against
 *    `/{owner}/{db}` (no `/branch` segment). Resolves the default
 *    branch on success. Returns `400 "no such repository"` for repos
 *    that are missing OR private (DoltHub's response shape is the same
 *    in both cases for anonymous callers).
 * 2. **Authenticated fallback** — only when stage 1 reports
 *    "no such repository" AND we have an OAuth token. Probes
 *    `/{owner}/{db}/main` with the token. DoltHub *requires* a refName
 *    on token-authed SQL calls, so we pick `main` (the modern default).
 *    Two outcomes prove the repo exists: `200 Success` (matches), or
 *    `200 Error "branch not found"` (the repo is real, just uses a
 *    different default branch — `master`, etc.). Anything else is a
 *    genuine miss.
 *
 * Returns `{ exists: true, defaultBranch }` on success, `{ exists:
 * false, reason }` when the API reports missing, and throws on
 * transport-level failures so callers can distinguish "doesn't exist"
 * from "couldn't tell".
 */
const DoltHubRepoProbeResponse = z
  .object({
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
    commit_ref: z.string().optional(),
    repository_owner: z.string().optional(),
    repository_name: z.string().optional(),
  })
  .passthrough();

export type VerifyUpstreamResult =
  | { exists: true; defaultBranch: string | null }
  | { exists: false; reason: string };

function buildProbeUrl(upstream: string, branch?: string): string {
  const [owner, db] = upstream.split('/');
  const segments = [encodeURIComponent(owner ?? ''), encodeURIComponent(db ?? '')];
  if (branch) segments.push(encodeURIComponent(branch));
  return `${DOLTHUB_API_BASE}/${segments.join('/')}?q=${encodeURIComponent('SELECT 1')}`;
}

async function runProbe(url: string, token: string | null) {
  const response = await fetch(url, {
    headers: token ? { authorization: `token ${token}` } : {},
  });
  const parsed = DoltHubRepoProbeResponse.safeParse(await response.json().catch(() => null));
  return { response, parsed };
}

export async function verifyDoltHubUpstreamExists(
  upstream: string,
  token: string | null
): Promise<VerifyUpstreamResult> {
  // Stage 1: anonymous probe. Branch is omitted so DoltHub auto-resolves
  // the default branch and surfaces it in `commit_ref` on success.
  const stage1 = await runProbe(buildProbeUrl(upstream), null);
  if (!stage1.parsed.success) {
    return {
      exists: false,
      reason: `DoltHub returned an unexpected response (${stage1.response.status})`,
    };
  }
  const stage1Data = stage1.parsed.data;
  if (stage1.response.ok && stage1Data.query_execution_status === 'Success') {
    return { exists: true, defaultBranch: stage1Data.commit_ref ?? null };
  }

  // Stage 1 said "no such repository" (or some other failure). If we
  // don't have a token to escalate, this is the final answer.
  if (!token) {
    return {
      exists: false,
      reason:
        stage1Data.query_execution_message?.trim() ||
        `Repository not found (HTTP ${stage1.response.status})`,
    };
  }

  // Stage 2: authenticated probe at `/main`. DoltHub requires a refName
  // when a token is present. "branch not found" with a 200 status is a
  // real-repo signal — the user just has a non-`main` default branch.
  const stage2 = await runProbe(buildProbeUrl(upstream, 'main'), token);
  if (!stage2.parsed.success) {
    return {
      exists: false,
      reason: `DoltHub returned an unexpected response (${stage2.response.status})`,
    };
  }
  const stage2Data = stage2.parsed.data;
  if (stage2.response.ok && stage2Data.query_execution_status === 'Success') {
    return { exists: true, defaultBranch: stage2Data.commit_ref ?? 'main' };
  }
  if (
    stage2.response.ok &&
    stage2Data.query_execution_status === 'Error' &&
    /branch not found/i.test(stage2Data.query_execution_message ?? '')
  ) {
    // Repo exists, just uses a non-`main` default. We don't know what
    // branch it actually uses without another probe, so return null.
    return { exists: true, defaultBranch: null };
  }

  return {
    exists: false,
    reason:
      stage2Data.query_execution_message?.trim() ||
      `Repository not found (HTTP ${stage2.response.status})`,
  };
}

/**
 * Persist the DoltHub username on the integration metadata so subsequent
 * wasteland connects can skip the prompt. Idempotent — overwrites whatever
 * was there before.
 */
export async function rememberDoltHubUsername(
  integration: PlatformIntegration,
  username: string
): Promise<void> {
  const metadata = readMetadata(integration);
  await db
    .update(platform_integrations)
    .set({
      metadata: { ...metadata, dolthub_username: username } satisfies DoltHubMetadata,
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));
}
