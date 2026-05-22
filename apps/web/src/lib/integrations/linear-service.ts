import 'server-only';
import { captureException, captureMessage } from '@sentry/nextjs';
import { LinearClient } from '@linear/sdk';
import { db } from '@/lib/drizzle';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET } from '@/lib/config.server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import {
  createAllowPredicateFromRestrictions,
  hasActiveModelRestrictions,
} from '@/lib/model-allow.server';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { getEffectiveModelRestrictions } from '@/lib/organizations/model-restrictions';

// OAuth scopes requested when installing Kilo into a Linear workspace.
// `app:mentionable` combined with `actor=app` gives us an app-actor install
// that participates in agent sessions when @-mentioned on an issue.
export const LINEAR_SCOPES = [
  'read',
  'write',
  'comments:create',
  'issues:create',
  'app:mentionable',
];

export const LINEAR_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.LINEAR);

const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';

/**
 * Revoke a Linear OAuth access token. This uninstalls the OAuth app from the
 * workspace on Linear's side, so a subsequent reinstall does not show the
 * "already installed" prompt.
 *
 * Returns true on a successful revoke, false otherwise. Errors are not thrown
 * because disconnect on our side should still succeed even if Linear is
 * unreachable or the token is already invalid.
 */
export async function revokeLinearToken(
  token: string,
  tokenTypeHint: 'access_token' | 'refresh_token' = 'access_token'
): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
    });

    const response = await fetch(LINEAR_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    // 200 = revoked. 400/401 typically mean the token was already revoked or
    // invalid, which is fine for our purposes; treat anything 2xx/4xx as a
    // terminal state and only log on unexpected failures.
    if (response.ok) return true;

    // Don't log the response body — Linear's revoke endpoint can echo back
    // sensitive token-related error detail.
    captureMessage('Failed to revoke Linear token', {
      level: 'warning',
      tags: { source: 'linear_oauth', op: 'revoke_token' },
      extra: { status: response.status, statusText: response.statusText, tokenTypeHint },
    });
    return false;
  } catch (error) {
    captureException(error, {
      level: 'warning',
      tags: { source: 'linear_oauth', op: 'revoke_token' },
    });
    return false;
  }
}

export class LinearWorkspaceAlreadyConnectedError extends Error {
  constructor(workspaceName: string) {
    super(
      `${workspaceName} is already connected to another Kilo account or organization. Disconnect it there before connecting it here.`
    );
    this.name = 'LinearWorkspaceAlreadyConnectedError';
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

/**
 * Build the Linear OAuth authorize URL.
 *
 * `actor=app` installs Kilo as an app actor in the workspace (required for
 * agent-sessions mode). `state` is the HMAC-signed state from
 * `createOAuthState`.
 */
export function getLinearOAuthUrl(state: string): string {
  if (!LINEAR_CLIENT_ID) {
    throw new Error('LINEAR_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: LINEAR_CLIENT_ID,
    scope: LINEAR_SCOPES.join(','),
    redirect_uri: LINEAR_REDIRECT_URI,
    response_type: 'code',
    actor: 'app',
    state,
  });

  return `https://linear.app/oauth/authorize?${params.toString()}`;
}

/**
 * Build a Linear OAuth authorize URL for the bot account-link flow.
 *
 * Differs from `getLinearOAuthUrl` (which is for installing the workspace
 * app) in three ways:
 *  - `actor=user` issues a token bound to the human signing in, not the
 *    app actor. We need this so `viewer { id }` returns the clicker's
 *    Linear user id rather than the configured app user.
 *  - `scope=read` is the minimum needed to query `viewer { id }` and
 *    `organization { id }`. We never use this token to write.
 *  - `prompt=consent` forces a fresh consent screen so the workspace's
 *    original installer cannot have their session silently reused when
 *    a different workspace member clicks the link.
 */
export function getLinearUserOAuthUrl(state: string): string {
  if (!LINEAR_CLIENT_ID) {
    throw new Error('LINEAR_CLIENT_ID is not configured');
  }

  const url = new URL('https://linear.app/oauth/authorize');
  url.searchParams.set('client_id', LINEAR_CLIENT_ID);
  url.searchParams.set('scope', 'read');
  url.searchParams.set('redirect_uri', LINEAR_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('actor', 'user');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export type LinearOAuthTokenResponse = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
};

/**
 * Exchange a Linear OAuth authorization code for a transient user-actor
 * access token. This is intentionally separate from
 * `linearAdapter.handleOAuthCallback` — that path persists a workspace
 * installation, but the bot-link flow only needs the token long enough
 * to query the viewer's identity, after which it is revoked.
 */
export async function exchangeLinearOAuthCode(code: string): Promise<LinearOAuthTokenResponse> {
  if (!LINEAR_CLIENT_ID || !LINEAR_CLIENT_SECRET) {
    throw new Error('LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET are not configured');
  }

  const body = new URLSearchParams({
    code,
    client_id: LINEAR_CLIENT_ID,
    client_secret: LINEAR_CLIENT_SECRET,
    redirect_uri: LINEAR_REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`Linear token exchange failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };

  if (typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
    throw new Error('Linear token exchange returned no access_token');
  }

  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : null,
    expiresIn: typeof payload.expires_in === 'number' ? payload.expires_in : null,
    scope: typeof payload.scope === 'string' ? payload.scope : null,
  };
}

export type LinearOAuthIdentity = {
  viewerId: string;
  viewerName: string | null;
  organizationId: string;
  organizationName: string | null;
};

/**
 * Query `viewer` and `organization` with a freshly-issued user-actor
 * access token. The returned `viewerId` is the Linear user id we will
 * link to the Kilo user; `organizationId` is checked against the signed
 * state so a multi-workspace user cannot link from a different workspace
 * than the one the link token was issued for.
 *
 * `LinearClient` wraps the GraphQL request / response handling and
 * throws `LinearGraphQLError` for both HTTP and GraphQL-level failures,
 * so errors propagate to the caller with a useful message.
 */
export async function fetchLinearOAuthIdentity(accessToken: string): Promise<LinearOAuthIdentity> {
  const linear = new LinearClient({ accessToken });
  const [viewer, organization] = await Promise.all([linear.viewer, linear.organization]);

  return {
    viewerId: viewer.id,
    viewerName: viewer.displayName ?? viewer.name ?? null,
    organizationId: organization.id,
    organizationName: organization.name ?? organization.urlKey ?? null,
  };
}

export async function getInstallation(owner: Owner): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.LINEAR))
    )
    .limit(1);

  return integration || null;
}

export async function getInstallationByOrganizationId(
  organizationId: string
): Promise<PlatformIntegration | null> {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.LINEAR),
        eq(platform_integrations.platform_installation_id, organizationId)
      )
    )
    .limit(1);

  return integration || null;
}

function isOwnedBy(integration: PlatformIntegration, owner: Owner): boolean {
  return owner.type === 'user'
    ? integration.owned_by_user_id === owner.id && integration.owned_by_organization_id === null
    : integration.owned_by_organization_id === owner.id && integration.owned_by_user_id === null;
}

async function getConflictingLinearInstallation(
  owner: Owner,
  organizationId: string
): Promise<PlatformIntegration | null> {
  const integrations = await db
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.LINEAR),
        eq(platform_integrations.platform_installation_id, organizationId)
      )
    )
    .limit(2);

  return integrations.find(integration => !isOwnedBy(integration, owner)) ?? null;
}

function isLinearWorkspaceUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    error.constraint === 'UQ_platform_integrations_linear_platform_inst'
  );
}

export function getOwnerFromInstallation(integration: PlatformIntegration): Owner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

type LinearUpsertOptions = {
  getChatSdkAccessToken?: (organizationId: string) => Promise<string | null>;
  deleteChatSdkInstallation?: (organizationId: string) => Promise<void>;
  deleteChatSdkIdentityCache?: (organizationId: string) => Promise<void>;
};

/**
 * Create or update a Linear `platform_integrations` row after a successful
 * OAuth exchange. The OAuth access/refresh tokens are persisted inside the
 * Chat SDK's state adapter by `linearAdapter.handleOAuthCallback`; this row
 * stores only non-secret metadata used by the tRPC router / UI and to gate
 * bot processing via `metadata.bot_enabled`.
 *
 * When the same Kilo owner reinstalls onto a *different* Linear workspace
 * (`existing.platform_installation_id !== organizationId`), the optional
 * cleanup callbacks are invoked to revoke the OAuth token Linear-side and
 * to drop the Chat SDK installation + identity cache for the previous
 * workspace. Without this, the old workspace stays authorized and keeps
 * sending webhooks to us with stale credentials, while no DB row connects
 * that organizationId back to a Kilo owner.
 */
export async function upsertLinearInstallation(
  {
    owner,
    organizationId,
    organizationName,
    botUserId,
  }: {
    owner: Owner;
    organizationId: string;
    organizationName: string;
    botUserId: string | null;
  },
  options: LinearUpsertOptions = {}
): Promise<PlatformIntegration> {
  const existing = await getInstallation(owner);

  const conflicting = await getConflictingLinearInstallation(owner, organizationId);
  if (conflicting) {
    throw new LinearWorkspaceAlreadyConnectedError(organizationName);
  }

  if (
    existing &&
    existing.platform_installation_id &&
    existing.platform_installation_id !== organizationId
  ) {
    const previousOrganizationId = existing.platform_installation_id;
    const previousAccessToken = await options.getChatSdkAccessToken?.(previousOrganizationId);
    if (previousAccessToken) {
      await revokeLinearToken(previousAccessToken);
    }
    await options.deleteChatSdkInstallation?.(previousOrganizationId);
    await options.deleteChatSdkIdentityCache?.(previousOrganizationId);
  }

  const defaultModel =
    owner.type === 'org'
      ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
      : DEFAULT_BOT_MODEL;

  const existingMetadata =
    existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {};

  const existingModelSlug =
    'model_slug' in existingMetadata && typeof existingMetadata.model_slug === 'string'
      ? existingMetadata.model_slug
      : null;

  const metadata = {
    ...existingMetadata,
    bot_enabled: true,
    bot_user_id: botUserId,
    model_slug: existingModelSlug ?? defaultModel,
  };

  if (existing) {
    try {
      const [updated] = await db
        .update(platform_integrations)
        .set({
          platform_installation_id: organizationId,
          platform_account_id: organizationId,
          platform_account_login: organizationName,
          scopes: LINEAR_SCOPES,
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata,
          updated_at: new Date().toISOString(),
        })
        .where(eq(platform_integrations.id, existing.id))
        .returning();

      return updated;
    } catch (error) {
      if (isLinearWorkspaceUniqueViolation(error)) {
        throw new LinearWorkspaceAlreadyConnectedError(organizationName);
      }
      throw error;
    }
  }

  try {
    const [created] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: owner.type === 'user' ? owner.id : null,
        owned_by_organization_id: owner.type === 'org' ? owner.id : null,
        platform: PLATFORM.LINEAR,
        integration_type: 'oauth',
        platform_installation_id: organizationId,
        platform_account_id: organizationId,
        platform_account_login: organizationName,
        scopes: LINEAR_SCOPES,
        integration_status: INTEGRATION_STATUS.ACTIVE,
        metadata,
        installed_at: new Date().toISOString(),
      })
      .returning();

    return created;
  } catch (error) {
    if (isLinearWorkspaceUniqueViolation(error)) {
      throw new LinearWorkspaceAlreadyConnectedError(organizationName);
    }
    throw error;
  }
}

type LinearUninstallOptions = {
  getChatSdkAccessToken?: (organizationId: string) => Promise<string | null>;
  deleteChatSdkInstallation?: (organizationId: string) => Promise<void>;
  deleteChatSdkIdentityCache?: (organizationId: string) => Promise<void>;
};

export async function uninstallApp(owner: Owner, options: LinearUninstallOptions = {}) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Linear installation not found',
    });
  }

  const organizationId = integration.platform_installation_id ?? integration.platform_account_id;
  const isActive = integration.integration_status === INTEGRATION_STATUS.ACTIVE;

  if (
    isActive &&
    (options.getChatSdkAccessToken ||
      options.deleteChatSdkInstallation ||
      options.deleteChatSdkIdentityCache)
  ) {
    if (!organizationId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Linear installation is missing an organization ID',
      });
    }

    // Fetch the access token from the chat-sdk adapter BEFORE deleting the
    // installation, then ask Linear to revoke it. This ensures the OAuth app
    // is properly uninstalled on Linear's side; otherwise the workspace will
    // see "already installed" on a reinstall attempt.
    const accessToken = await options.getChatSdkAccessToken?.(organizationId);
    if (accessToken) {
      await revokeLinearToken(accessToken);
    }

    await options.deleteChatSdkInstallation?.(organizationId);
    await options.deleteChatSdkIdentityCache?.(organizationId);
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

export async function deleteInstallationByOrganizationId(organizationId: string) {
  const integration = await getInstallationByOrganizationId(organizationId);

  if (!integration) {
    return { success: true, deleted: false };
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true, deleted: true };
}

/**
 * Dev-only helper. Drops the DB row without contacting Linear so the OAuth
 * flow can be re-tested without reinstalling the app in the workspace.
 */
export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Linear installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Update the model used for Linear interactions.
 * For organization-owned installations, validates the model against the org's
 * access policy the same way `slack-service.updateModel` does.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Linear installation found' };
  }

  if (owner.type === 'org') {
    const organization = await getOrganizationById(owner.id);
    if (organization) {
      const restrictions = getEffectiveModelRestrictions(organization);
      if (hasActiveModelRestrictions(restrictions)) {
        const isAllowed = createAllowPredicateFromRestrictions(restrictions);
        if (!(await isAllowed(modelSlug))) {
          return { success: false, error: 'Model is not allowed by organization policy' };
        }
      }
    }
  }

  const existingMetadata = (integration.metadata || {}) as Record<string, unknown>;

  await db
    .update(platform_integrations)
    .set({
      metadata: {
        ...existingMetadata,
        model_slug: modelSlug,
      },
      updated_at: new Date().toISOString(),
    })
    .where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

export async function getModel(owner: Owner): Promise<string | null> {
  const integration = await getInstallation(owner);
  if (!integration) return null;
  const metadata = integration.metadata as { model_slug?: string } | null;
  return metadata?.model_slug || null;
}
