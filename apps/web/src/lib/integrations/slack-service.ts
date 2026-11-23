import 'server-only';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import type { PlatformIntegration, SlackOAuthCredential } from '@kilocode/db/schema';
import { platform_integrations } from '@kilocode/db/schema';
import { eq, and, isNull, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { Owner } from '@/lib/integrations/core/types';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '@kilocode/web-shared/lib/config.server';
import { WebClient } from '@slack/web-api';
import type { SlackInstallation } from '@chat-adapter/slack';
import { getDefaultAllowedModel } from '@/lib/slack-bot/model-allow-list';
import { DEFAULT_BOT_MODEL } from '@/lib/bot/constants';
import { resolveOrganizationBotModel } from '@/lib/bot/organization-model';
import { isOrganizationModelUpdateAllowed } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import {
  decryptSlackBotToken,
  getSlackCredentialByIntegrationId,
  writeSlackCredential,
} from '@/lib/integrations/platforms/slack/credential-store';
import {
  SLACK_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
  SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
} from '@kilocode/app-shared/integrations-errors';
import { SlackCredentialDecryptionError } from '@/lib/integrations/platforms/slack/credential-encryption';
import { captureException } from '@sentry/nextjs';

export class SlackWorkspaceAlreadyConnectedError extends Error {
  constructor(teamName: string) {
    super(
      `${teamName} is already connected to another Kilo account or organization. Disconnect it there before connecting it here.`
    );
    this.name = 'SlackWorkspaceAlreadyConnectedError';
  }
}

export class SlackWorkspaceRebindNotAllowedError extends Error {
  constructor() {
    super(
      'This organization is already connected to a different Slack workspace. Disconnect it before connecting another workspace.'
    );
    this.name = 'SlackWorkspaceRebindNotAllowedError';
  }
}

/**
 * Why a rebind cannot settle the workspace it would replace.
 * `read_failed` is a read that threw: a retry can produce a token to revoke.
 * `credential_unreadable` is a handle this code can never revoke, so only the
 * operator path can clear it.
 */
export type SlackWorkspaceRebindUnsettledReason = 'read_failed' | 'credential_unreadable';

/**
 * A rebind to a different Slack workspace would replace the only record of a
 * bot token whose revocation could not be prepared. The previous binding is kept.
 */
export class SlackWorkspaceRebindUnsettledError extends Error {
  constructor(readonly reason: SlackWorkspaceRebindUnsettledReason) {
    super(
      reason === 'read_failed'
        ? 'Slack could not confirm the move away from the previous workspace. Try again.'
        : 'Kilo could not read the Slack access saved for the previous workspace, so the connection was not moved. Contact support to finish disconnecting it.'
    );
    this.name = 'SlackWorkspaceRebindUnsettledError';
  }
}

// Slack OAuth scopes for the integration
// These should be kept in sync with the scopes requested in the Slack app configuration
export const SLACK_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'files:read',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'team:read',
  'users:read',
];

export function getMissingSlackScopes(installedScopes: string[] | null): string[] {
  const installedScopeSet = new Set(installedScopes ?? []);
  return SLACK_SCOPES.filter(scope => !installedScopeSet.has(scope));
}

const SLACK_REDIRECT_URI = getPlatformOAuthCallbackUrl(PLATFORM.SLACK);

type SlackUninstallOptions = {
  deleteChatSdkInstallation?: (teamId: string) => Promise<void>;
  deleteChatSdkIdentityCache?: (teamId: string) => Promise<void>;
};

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
 * Get Slack OAuth URL for initiating the OAuth flow
 */
export function getSlackOAuthUrl(state: string): string {
  if (!SLACK_CLIENT_ID) {
    throw new Error('SLACK_CLIENT_ID is not configured');
  }

  const params = new URLSearchParams({
    client_id: SLACK_CLIENT_ID,
    scope: SLACK_SCOPES.join(','),
    redirect_uri: SLACK_REDIRECT_URI,
    state,
  });

  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export type SlackOAuthExchangeResult = {
  installationId: string;
  enterpriseId: string | undefined;
  isEnterpriseInstall: boolean;
  installation: SlackInstallation;
};

/**
 * Exchange a Slack OAuth V2 authorization code for a workspace installation.
 *
 * Produces the same installation record `slackAdapter.handleOAuthCallback`
 * persists, but without writing it, so the callback can resolve which workspace
 * is being connected and check its ownership first. Enterprise Grid org-wide
 * installs are keyed on the enterprise ID, matching the adapter.
 */
export async function exchangeSlackOAuthCode(code: string): Promise<SlackOAuthExchangeResult> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new Error('SLACK_CLIENT_ID / SLACK_CLIENT_SECRET are not configured');
  }

  const result = await new WebClient().oauth.v2.access({
    client_id: SLACK_CLIENT_ID,
    client_secret: SLACK_CLIENT_SECRET,
    code,
    redirect_uri: SLACK_REDIRECT_URI,
  });

  const isEnterpriseInstall = Boolean(result.is_enterprise_install);
  const enterpriseId = result.enterprise?.id;
  const installationId = isEnterpriseInstall ? enterpriseId : result.team?.id;

  if (!result.ok || !result.access_token || !installationId) {
    throw new Error(
      isEnterpriseInstall
        ? 'Slack OAuth failed: missing access_token or enterprise id'
        : 'Slack OAuth failed: missing access_token or team id'
    );
  }

  return {
    installationId,
    enterpriseId,
    isEnterpriseInstall,
    installation: {
      botToken: result.access_token,
      botUserId: result.bot_user_id,
      teamName: result.team?.name ?? result.enterprise?.name,
      ...(enterpriseId ? { enterpriseId } : {}),
      ...(isEnterpriseInstall ? { isEnterpriseInstall } : {}),
    },
  };
}

/**
 * Outcome of asking Slack to revoke a token.
 * `already_invalid` means Slack no longer honours the token, so nothing is left to revoke.
 * `temporary_failure` means the call did not settle the question and is worth retrying.
 */
export type SlackTokenRevocation =
  | { status: 'revoked' }
  | { status: 'already_invalid'; slackError: string }
  | { status: 'temporary_failure'; reason: SlackTokenRevocationFailureReason };

export type SlackTokenRevocationFailureReason =
  | 'rate_limited'
  | 'http_error'
  | 'network'
  | 'unknown';

/** Slack error codes that mean the token is already gone, so revocation is complete. */
const SLACK_TOKEN_ALREADY_INVALID_ERRORS: Record<string, true> = {
  token_revoked: true,
  invalid_auth: true,
  not_authed: true,
  account_inactive: true,
  token_expired: true,
};

/**
 * Read the `code` (and the platform error string, when present) out of a thrown value.
 * The `@slack/web-api` errors are plain objects with these fields; nothing else is read,
 * so an unrecognised value simply yields the `unknown` shape.
 */
function readSlackApiError(error: unknown): { code: string | null; slackError: string | null } {
  if (typeof error !== 'object' || error === null) {
    return { code: null, slackError: null };
  }

  const code = 'code' in error && typeof error.code === 'string' ? error.code : null;

  if (!('data' in error)) {
    return { code, slackError: null };
  }

  const data = error.data;
  const slackError =
    typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
      ? data.error
      : null;

  return { code, slackError };
}

function getRevocationFailureReason(code: string | null): SlackTokenRevocationFailureReason {
  switch (code) {
    case 'slack_webapi_rate_limited_error':
      return 'rate_limited';
    case 'slack_webapi_http_error':
      return 'http_error';
    case 'slack_webapi_request_error':
      return 'network';
    default:
      return 'unknown';
  }
}

function reportRevocationFailure(
  reason: SlackTokenRevocationFailureReason,
  slackError: string | null
): SlackTokenRevocation {
  // Never hand the SDK error to Sentry: its payload can carry the request config.
  captureException(new Error(`Slack token revocation failed: ${reason}`), {
    tags: { component: 'slack-service', op: 'revoke-slack-token' },
    extra: { reason, slackError: slackError ?? undefined },
  });

  return { status: 'temporary_failure', reason };
}

/**
 * Revoke Slack access token.
 * Never throws: a Slack refusal is reported in the result, because the caller has to tell
 * "Slack says the token is already dead" apart from "Slack did not answer".
 */
export async function revokeSlackToken(accessToken: string): Promise<SlackTokenRevocation> {
  // The SDK's default policy retries for about thirty minutes, well past the tRPC
  // route's 800 s budget; one bounded retry covers a single blip, and a 429 answers
  // at once as a rate-limit result instead of sleeping out the retry-after.
  const client = new WebClient(accessToken, {
    retryConfig: { retries: 1, minTimeout: 500, maxTimeout: 2_000 },
    rejectRateLimitedCalls: true,
  });

  try {
    const result = await client.auth.revoke();
    // The SDK throws on `ok:false`, so a resolved non-ok body only comes from a stand-in.
    if (result.ok === true) {
      return { status: 'revoked' };
    }
    return reportRevocationFailure('unknown', null);
  } catch (error) {
    const { code, slackError } = readSlackApiError(error);

    if (
      code === 'slack_webapi_platform_error' &&
      slackError !== null &&
      SLACK_TOKEN_ALREADY_INVALID_ERRORS[slackError] === true
    ) {
      return { status: 'already_invalid', slackError };
    }

    return reportRevocationFailure(getRevocationFailureReason(code), slackError);
  }
}

/**
 * Get Slack installation for an owner
 * For user-owned integrations, we explicitly check that owned_by_organization_id is null
 * to avoid returning organization-owned integrations
 */
export async function getInstallation(
  owner: Owner,
  database: typeof db | DrizzleTransaction = db
): Promise<PlatformIntegration | null> {
  const [integration] = await database
    .select()
    .from(platform_integrations)
    .where(
      and(...getOwnershipConditions(owner), eq(platform_integrations.platform, PLATFORM.SLACK))
    )
    // A row that records the workspace in `platform_installation_id` is the one
    // inbound events resolve to. Prefer it over a legacy row that carries the
    // workspace id only in `platform_account_id`, so an update targets that row
    // instead of colliding with it in the owner-scoped unique index.
    .orderBy(
      sql`${platform_integrations.platform_installation_id} IS NULL`,
      platform_integrations.id
    )
    .limit(1);

  return integration || null;
}

/**
 * A row can record its workspace in `platform_account_id` while
 * `platform_installation_id` is empty. Rows the duplicate-workspace migration
 * detached carry `duplicate_slack_platform_installation_id` in the metadata.
 */
function legacySlackWorkspaceCondition(teamId: string) {
  return and(
    eq(platform_integrations.platform_account_id, teamId),
    isNull(platform_integrations.platform_installation_id),
    sql`${platform_integrations.metadata}->>'duplicate_slack_platform_installation_id' IS NULL`
  );
}

/**
 * Rows that record a workspace: its canonical row, plus a legacy row that carries
 * the workspace id only in `platform_account_id`.
 */
function recordsSlackWorkspaceCondition(teamId: string) {
  return or(
    eq(platform_integrations.platform_installation_id, teamId),
    legacySlackWorkspaceCondition(teamId)
  );
}

function isOwnedBy(integration: PlatformIntegration, owner: Owner): boolean {
  return owner.type === 'user'
    ? integration.owned_by_user_id === owner.id && integration.owned_by_organization_id === null
    : integration.owned_by_organization_id === owner.id && integration.owned_by_user_id === null;
}

/**
 * The complement of `isOwnedBy` as a filter. `NOT` over the nullable owner columns
 * would drop rows, so each owner is compared with `IS NOT DISTINCT FROM` and the
 * other owner column with `IS NULL`.
 */
function isOwnedByAnotherOwner(owner: Owner) {
  return owner.type === 'user'
    ? sql`NOT (${platform_integrations.owned_by_user_id} IS NOT DISTINCT FROM ${owner.id} AND ${platform_integrations.owned_by_organization_id} IS NULL)`
    : sql`NOT (${platform_integrations.owned_by_organization_id} IS NOT DISTINCT FROM ${owner.id} AND ${platform_integrations.owned_by_user_id} IS NULL)`;
}

/**
 * Find a Slack `platform_integrations` row for `teamId` that belongs to a
 * different Kilo owner. Callers use this before persisting a workspace
 * installation so a workspace owned elsewhere is rejected without writing to
 * the shared Chat SDK installation state.
 *
 * A workspace resolves to the row that holds it as its canonical installation id.
 * Only when no such row exists do rows that record the workspace in
 * `platform_account_id` take part, matching how `upsertSlackInstallation` reads the
 * bound workspace of an existing row.
 */
export async function getConflictingSlackInstallation(
  owner: Owner,
  teamId: string,
  database: typeof db | DrizzleTransaction = db
): Promise<PlatformIntegration | null> {
  const [canonical] = await database
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId)
      )
    )
    .limit(1);

  if (canonical) {
    return isOwnedBy(canonical, owner) ? null : canonical;
  }

  const [conflicting] = await database
    .select()
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        legacySlackWorkspaceCondition(teamId),
        isOwnedByAnotherOwner(owner)
      )
    )
    .limit(1);

  return conflicting ?? null;
}

function isSlackWorkspaceUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;

  if (
    'constraint' in error &&
    error.constraint === 'UQ_platform_integrations_slack_platform_inst'
  ) {
    return true;
  }

  return (
    'message' in error &&
    typeof error.message === 'string' &&
    error.message.includes('UQ_platform_integrations_slack_platform_inst')
  );
}

/**
 * Get the owner information from a Slack installation
 */
export function getOwnerFromInstallation(integration: PlatformIntegration): Owner | null {
  if (integration.owned_by_organization_id) {
    return { type: 'org', id: integration.owned_by_organization_id };
  }
  if (integration.owned_by_user_id) {
    return { type: 'user', id: integration.owned_by_user_id };
  }
  return null;
}

/**
 * A credential-store read that keeps "nothing is stored" apart from "something is
 * stored but this code cannot use it". Only `absent` means no Slack grant can be
 * reached through the row.
 */
export type SlackBotTokenRead =
  | { status: 'available'; token: string }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: 'read_failed' | 'owner_missing' | 'decrypt_failed' };

/**
 * Load the bot token for an integration from the encrypted credential store,
 * reporting why a token is not available.
 *
 * Failures are reported to the error tracker with the integration id only. An
 * integration with no exclusive owner reports `owner_missing`: the row records a
 * connection this code cannot address, which is not the same as having none, and
 * no retry of this read changes that.
 *
 * A credential row already marked revoked reports `absent`: the store refuses to
 * decrypt it, and Slack has already given up that token.
 */
export async function readSlackBotToken(
  integration: PlatformIntegration
): Promise<SlackBotTokenRead> {
  const owner = getOwnerFromInstallation(integration);
  if (!owner) {
    // Terminal for this read path: re-reading the same row cannot produce an owner.
    captureException(new Error('Slack integration has no exclusive owner'), {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: { integrationId: integration.id },
    });
    return { status: 'unavailable', reason: 'owner_missing' };
  }

  let credential: SlackOAuthCredential | null;
  try {
    credential = await getSlackCredentialByIntegrationId(integration.id);
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: { integrationId: integration.id },
    });
    return { status: 'unavailable', reason: 'read_failed' };
  }
  if (!credential) return { status: 'absent' };

  try {
    // A revoked row decrypts to null: Slack already dropped that token, so nothing
    // is live and the row is safe to remove.
    const token = decryptSlackBotToken(credential, owner);
    if (!token) return { status: 'absent' };
    return { status: 'available', token };
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'slack-service', op: 'read-slack-credential' },
      extra: {
        integrationId: integration.id,
        kind: error instanceof SlackCredentialDecryptionError ? error.kind : 'unknown',
      },
    });
    return { status: 'unavailable', reason: 'decrypt_failed' };
  }
}

/**
 * Load the bot token for an integration from the encrypted credential store.
 *
 * Returns null when no credential row exists, the row is revoked, or the row cannot
 * be read. Failures are reported to the error tracker with the integration id only;
 * callers treat null as "no access token" and surface their own user-facing error.
 */
export async function getSlackBotToken(integration: PlatformIntegration): Promise<string | null> {
  const read = await readSlackBotToken(integration);
  return read.status === 'available' ? read.token : null;
}

export type PreviousSlackWorkspace = {
  /** Slack team id the owner's connection was bound to before this install. */
  teamId: string;
  /**
   * Bot token to revoke once the rebind has committed, or null when the store
   * holds nothing live for the previous workspace.
   */
  botToken: string | null;
};

/**
 * Read the bot token of the workspace a rebind replaces, before the write that
 * overwrites its only record. A read that yields no token refuses the rebind,
 * because after the write this code could never revoke it: `read_failed` is
 * worth a retry, and an unreadable credential needs the operator path.
 */
async function readReplacedSlackWorkspace(
  existing: PlatformIntegration,
  teamId: string
): Promise<PreviousSlackWorkspace> {
  const read = await readSlackBotToken(existing);
  if (read.status === 'unavailable') {
    throw new SlackWorkspaceRebindUnsettledError(
      read.reason === 'read_failed' ? 'read_failed' : 'credential_unreadable'
    );
  }
  return { teamId, botToken: read.status === 'available' ? read.token : null };
}

export type UpsertSlackInstallationResult = {
  integration: PlatformIntegration;
  /**
   * The workspace this install replaces, when the owner installs onto a different
   * Slack workspace. The caller retires it after its transaction has committed;
   * see `retirePreviousSlackWorkspace`.
   */
  previousWorkspace: PreviousSlackWorkspace | null;
};

/**
 * Create or update Slack installation from the Chat SDK OAuth callback result.
 *
 * An organization connection holds a shared bot token and model policy, so moving
 * it to another Slack workspace is refused unless the caller passes
 * `allowWorkspaceRebind` after verifying organization-management authority.
 *
 * A move to a different workspace replaces the only row that names the previous
 * workspace's bot token, so the token is read here, before the write, and handed
 * back for revocation once the rebind commits. When that read cannot produce a
 * token to revoke, the rebind is refused and the previous binding stays.
 */
export async function upsertSlackInstallation(
  {
    owner,
    teamId,
    installation,
    allowWorkspaceRebind = false,
    defaultModel: suppliedDefaultModel,
  }: {
    owner: Owner;
    teamId: string;
    installation: SlackInstallation;
    allowWorkspaceRebind?: boolean;
    /**
     * Model resolved by the caller before the install transaction. `null` means
     * the owner's policy allows no candidate model; `undefined` resolves it here.
     */
    defaultModel?: string | null;
  },
  database: typeof db | DrizzleTransaction = db
): Promise<UpsertSlackInstallationResult> {
  const existing = await getInstallation(owner, database);
  const teamName = installation.teamName || 'Unknown Team';
  // Legacy rows can carry the workspace id only in `platform_account_id`.
  const boundTeamId = existing?.platform_installation_id ?? existing?.platform_account_id ?? null;

  const conflicting = await getConflictingSlackInstallation(owner, teamId, database);
  if (conflicting) {
    throw new SlackWorkspaceAlreadyConnectedError(teamName);
  }

  if (
    existing &&
    !allowWorkspaceRebind &&
    owner.type === 'org' &&
    boundTeamId &&
    boundTeamId !== teamId
  ) {
    throw new SlackWorkspaceRebindNotAllowedError();
  }

  const previousWorkspace =
    existing && boundTeamId && boundTeamId !== teamId
      ? await readReplacedSlackWorkspace(existing, boundTeamId)
      : null;

  // For org integrations, get a model that respects org access policy. A null
  // result means the policy allows none of the candidates; the installation then
  // stores no `model_slug` and the UI keeps its "Select a model" state.
  // For user integrations, use the shared bot default model.
  const defaultModel =
    suppliedDefaultModel !== undefined
      ? suppliedDefaultModel
      : owner.type === 'org'
        ? await getDefaultAllowedModel(owner.id, DEFAULT_BOT_MODEL)
        : DEFAULT_BOT_MODEL;

  const existingModelSlug =
    existing?.metadata &&
    typeof existing.metadata === 'object' &&
    'model_slug' in existing.metadata &&
    typeof existing.metadata.model_slug === 'string'
      ? existing.metadata.model_slug
      : null;
  const modelSlug = existingModelSlug ?? defaultModel;

  const metadata: Record<string, unknown> = {
    ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
    bot_user_id: installation.botUserId,
  };
  if (modelSlug) {
    metadata.model_slug = modelSlug;
  } else {
    delete metadata.model_slug;
  }
  delete metadata.access_token;
  // The row becomes the active record of this workspace, so the markers that
  // identified it as a detached duplicate no longer describe it.
  delete metadata.duplicate_slack_platform_installation_id;
  delete metadata.duplicate_slack_platform_installation_detached_at;

  if (existing) {
    try {
      return await database.transaction(async tx => {
        const [updated] = await tx
          .update(platform_integrations)
          .set({
            platform_installation_id: teamId,
            platform_account_id: teamId,
            platform_account_login: teamName,
            scopes: SLACK_SCOPES,
            integration_status: INTEGRATION_STATUS.ACTIVE,
            suspended_at: null,
            suspended_by: null,
            metadata,
            updated_at: new Date().toISOString(),
          })
          .where(eq(platform_integrations.id, existing.id))
          .returning();

        // Both writes commit together: the integration row and its credential row
        // form one unit, and each is incomplete without the other.
        await writeSlackCredential(
          {
            integrationId: updated.id,
            slackTeamId: teamId,
            owner,
            botToken: installation.botToken,
            botUserId: installation.botUserId ?? null,
          },
          tx
        );

        return { integration: updated, previousWorkspace };
      });
    } catch (error) {
      if (isSlackWorkspaceUniqueViolation(error)) {
        throw new SlackWorkspaceAlreadyConnectedError(teamName);
      }
      throw error;
    }
  }

  try {
    const created = await database.transaction(async tx => {
      const [inserted] = await tx
        .insert(platform_integrations)
        .values({
          owned_by_user_id: owner.type === 'user' ? owner.id : null,
          owned_by_organization_id: owner.type === 'org' ? owner.id : null,
          platform: PLATFORM.SLACK,
          integration_type: 'oauth',
          platform_installation_id: teamId,
          platform_account_id: teamId,
          platform_account_login: teamName,
          scopes: SLACK_SCOPES,
          integration_status: INTEGRATION_STATUS.ACTIVE,
          metadata,
          installed_at: new Date().toISOString(),
        })
        .returning();

      await writeSlackCredential(
        {
          integrationId: inserted.id,
          slackTeamId: teamId,
          owner,
          botToken: installation.botToken,
          botUserId: installation.botUserId ?? null,
        },
        tx
      );

      return inserted;
    });
    // A new row has no earlier workspace to replace.
    return { integration: created, previousWorkspace: null };
  } catch (error) {
    if (isSlackWorkspaceUniqueViolation(error)) {
      throw new SlackWorkspaceAlreadyConnectedError(teamName);
    }
    throw error;
  }
}

/**
 * Uninstall Slack integration for an owner
 */
export async function uninstallApp(owner: Owner, options: SlackUninstallOptions = {}) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slack installation not found',
    });
  }

  const shouldDeleteSlackInstallation =
    integration.integration_status === INTEGRATION_STATUS.ACTIVE;

  if (shouldDeleteSlackInstallation) {
    const tokenRead = await readSlackBotToken(integration);
    if (tokenRead.status === 'unavailable') {
      // Only a transient read failure can end differently on a retry, so only
      // `read_failed` offers one. A credential the keyset cannot decrypt, and a
      // row with no usable owner, stay the same on every attempt, so their copy
      // names the support step instead.
      //
      // `read_failed` is the credential-store read throwing (a database or
      // connection failure), not a decryption failure: the decrypt has its own
      // outcome below, so the retry branch is not a bug.
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message:
          tokenRead.reason === 'read_failed'
            ? SLACK_DISCONNECT_UNCONFIRMED_MESSAGE
            : SLACK_DISCONNECT_NEEDS_SUPPORT_MESSAGE,
      });
    }
    if (tokenRead.status === 'available') {
      const revocation = await revokeSlackToken(tokenRead.token);
      if (revocation.status === 'temporary_failure') {
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: SLACK_DISCONNECT_UNCONFIRMED_MESSAGE,
        });
      }
    }
  }

  const teamId = integration.platform_installation_id ?? integration.platform_account_id;
  if (
    shouldDeleteSlackInstallation &&
    (options.deleteChatSdkInstallation || options.deleteChatSdkIdentityCache)
  ) {
    if (!teamId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Slack installation is missing a team ID',
      });
    }

    await options.deleteChatSdkInstallation?.(teamId);
    await options.deleteChatSdkIdentityCache?.(teamId);
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Retire the workspace a successful install replaced. Call this only after the
 * caller's transaction has committed: the connection row already names the new
 * workspace, so the previous one's token and Chat SDK state are settled beside it.
 *
 * A token Slack does not confirm as revoked is reported with its team id, the
 * only place that still names it, rather than thrown: the new connection stands.
 */
export async function retirePreviousSlackWorkspace(
  previous: PreviousSlackWorkspace,
  options: SlackUninstallOptions = {}
): Promise<void> {
  try {
    if (previous.botToken) {
      const revocation = await revokeSlackToken(previous.botToken);
      if (revocation.status === 'temporary_failure') {
        captureException(new Error('Slack token revocation did not settle a replaced workspace'), {
          tags: { component: 'slack-service', op: 'retire-previous-workspace' },
          extra: { teamId: previous.teamId, reason: revocation.reason },
        });
      }
    }
    await options.deleteChatSdkInstallation?.(previous.teamId);
    await options.deleteChatSdkIdentityCache?.(previous.teamId);
  } catch (error) {
    // The new connection is already committed; this cleanup runs beside it.
    captureException(error, {
      tags: { component: 'slack-service', op: 'retire-previous-workspace' },
      extra: { teamId: previous.teamId },
    });
  }
}

/**
 * Remove every row that records a workspace after Slack reports the app removed
 * from it. A row that records the workspace in the account id is removed with the
 * canonical row; a row the duplicate-workspace migration detached is left in place.
 */
export async function deleteInstallationByTeamId(teamId: string) {
  const deleted = await db
    .delete(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        recordsSlackWorkspaceCondition(teamId)
      )
    )
    .returning({ id: platform_integrations.id });

  return { success: true, deleted: deleted.length > 0 };
}

/**
 * Remove only the database row for a Slack integration without revoking the token on Slack's side.
 * This is useful for development when you want to re-test the OAuth flow without
 * having to re-install the app in Slack.
 */
export async function removeDbRowOnly(owner: Owner) {
  const integration = await getInstallation(owner);

  if (!integration) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Slack installation not found',
    });
  }

  await db.delete(platform_integrations).where(eq(platform_integrations.id, integration.id));

  return { success: true };
}

/**
 * Test Slack connection by calling auth.test
 */
export async function testConnection(owner: Owner): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  const botToken = await getSlackBotToken(integration);

  if (!botToken) {
    return { success: false, error: 'No access token found' };
  }

  try {
    const client = new WebClient(botToken);
    const result = await client.auth.test();

    if (!result.ok) {
      return { success: false, error: result.error || 'Unknown error' };
    }

    return { success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

/**
 * Update the model for a Slack integration.
 * For organization-owned integrations, validates the model against org access policy.
 */
export async function updateModel(
  owner: Owner,
  modelSlug: string
): Promise<{ success: boolean; error?: string }> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return { success: false, error: 'No Slack installation found' };
  }

  // For org integrations, validate the model against org access policy.
  if (owner.type === 'org') {
    if (!(await isOrganizationModelUpdateAllowed(owner.id, modelSlug))) {
      return { success: false, error: 'Model is not allowed by organization policy' };
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

/**
 * Get the model for a Slack integration. For organization-owned integrations,
 * resolves the stored model through the organization's current policy, falling
 * back to the allowed default; a user-owned integration keeps its stored model.
 */
export async function getModel(owner: Owner): Promise<string | null> {
  const integration = await getInstallation(owner);

  if (!integration) {
    return null;
  }

  const metadata = integration.metadata as { model_slug?: string } | null;
  const storedModelSlug = metadata?.model_slug || null;
  if (!storedModelSlug) {
    return null;
  }
  return resolveOrganizationBotModel({
    organizationId: owner.type === 'org' ? owner.id : null,
    storedModelSlug,
  });
}

/*
 * Slack message posting params
 */
export type PostSlackMessageParams = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: Array<{ type: string; text?: { type: string; text: string } }>;
};

/**
 * Slack message posting response
 */
export type SlackPostMessageResponse = {
  ok: boolean;
  ts?: string;
  error?: string;
};

/**
 * Post a message to Slack using an access token directly
 */
export async function postSlackMessageByAccessToken(
  accessToken: string,
  params: PostSlackMessageParams
): Promise<SlackPostMessageResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.chat.postMessage({
      channel: params.channel,
      text: params.text,
      thread_ts: params.thread_ts,
      blocks: params.blocks,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true, ts: result.ts };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error posting message:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Slack reaction response
 */
export type SlackReactionResponse = {
  ok: boolean;
  error?: string;
};

/**
 * Add a reaction to a message using an access token directly
 */
export async function addSlackReactionByAccessToken(
  accessToken: string,
  params: { channel: string; timestamp: string; name: string }
): Promise<SlackReactionResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.reactions.add({
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error adding reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}

/**
 * Remove a reaction from a message using an access token directly
 */
export async function removeSlackReactionByAccessToken(
  accessToken: string,
  params: { channel: string; timestamp: string; name: string }
): Promise<SlackReactionResponse> {
  try {
    const client = new WebClient(accessToken);
    const result = await client.reactions.remove({
      channel: params.channel,
      timestamp: params.timestamp,
      name: params.name,
    });

    if (!result.ok) {
      return { ok: false, error: result.error || 'Unknown error' };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('[SlackService] Error removing reaction:', errorMessage);
    return { ok: false, error: errorMessage };
  }
}
