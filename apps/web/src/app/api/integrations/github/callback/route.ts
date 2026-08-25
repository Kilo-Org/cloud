import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { platform_integrations, type User } from '@kilocode/db/schema';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import {
  exchangeGitHubOAuthCode,
  fetchGitHubInstallationRequests,
} from '@/lib/integrations/platforms/github/adapter';
import {
  getGitHubAppTypeForOrganization,
  getGitHubAppCredentials,
  assertUserAdministersInstallation,
  type GitHubAppType,
} from '@/lib/integrations/platforms/github/app-selector';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  createPendingIntegration,
  findIntegrationByInstallationId,
  upsertPlatformIntegrationForOwner,
} from '@/lib/integrations/db/platform-integrations';
import type {
  PlatformRepository,
  IntegrationPermissions,
  Owner,
} from '@/lib/integrations/core/types';
import { db } from '@/lib/drizzle';
import { and, eq, isNull } from 'drizzle-orm';
import { parseStateReturn } from '@/lib/integrations/validate-return-path';
import { captureException, captureMessage } from '@sentry/nextjs';
import { verifyGitHubBotLinkState } from '@/lib/bot/github-link-state';
import { linkKiloUser } from '@/lib/bot-identity';
import { bot } from '@/lib/bot';
import { isOrganizationMember } from '@/lib/organizations/organizations';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { APP_URL } from '@/lib/constants';
import { consumeInstallState } from '@/lib/integrations/github/install-state';
import type { GitHubInstallState } from '@kilocode/db/schema';
import { getEnvVariable } from '@/lib/dotenvx';

const appendQueryParam = (path: string, queryParam: string): string =>
  `${path}${path.includes('?') ? '&' : '?'}${queryParam}`;

type InstallStateClass =
  | 'none'
  | 'legacy_org'
  | 'legacy_user'
  | 'bot_link'
  | 'install_token'
  | 'unknown';

/**
 * Classifies a GitHub callback state value without revealing its contents.
 * Database install states are bearer tokens, so diagnostics must never carry
 * the raw value — only its shape class.
 */
function classifyInstallState(rawState: string | null): InstallStateClass {
  if (!rawState) return 'none';
  if (rawState.startsWith('org_')) return 'legacy_org';
  if (rawState.startsWith('user_')) return 'legacy_user';
  if (rawState.includes('.')) return 'bot_link';
  // Database install tokens are 32 random bytes, base64url-encoded (no dots).
  if (/^[A-Za-z0-9_-]{16,}$/.test(rawState)) return 'install_token';
  return 'unknown';
}

function htmlPage(title: string, message: string, status = 200): Response {
  return new Response(
    `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

async function handleGitHubBotLinkCallback(request: NextRequest, user: { id: string }) {
  const searchParams = request.nextUrl.searchParams;
  const code = searchParams.get('code');
  const state = verifyGitHubBotLinkState(searchParams.get('state'));

  if (!code || !state) {
    return htmlPage(
      'Link Failed',
      'Invalid or expired GitHub link request. Please try again.',
      400
    );
  }

  if (state.userId !== user.id) {
    return htmlPage(
      'Link Failed',
      'This GitHub link request was started by another Kilo user.',
      403
    );
  }

  // Bot-link states carry no GitHub app type, so this lookup is intentionally
  // unscoped; the integration row's own github_app_type drives the OAuth
  // exchange below. Ownership checks then restrict the result to this user.
  const integration = await findIntegrationByInstallationId(PLATFORM.GITHUB, state.installationId);

  if (!integration) {
    return htmlPage('Link Failed', 'No matching GitHub integration was found.', 404);
  }

  if (integration.owned_by_organization_id) {
    const isMember = await isOrganizationMember(integration.owned_by_organization_id, user.id);
    if (!isMember) {
      return htmlPage(
        'Link Failed',
        'You are not a member of the organization that owns this GitHub integration.',
        403
      );
    }
  } else if (integration.owned_by_user_id !== user.id) {
    return htmlPage('Link Failed', 'You are not the owner of this GitHub integration.', 403);
  }

  const appType = (integration.github_app_type ?? 'standard') as GitHubAppType;
  const githubUser = await exchangeGitHubOAuthCode(code, appType);

  await bot.initialize();
  await linkKiloUser(
    bot.getState(),
    {
      platform: PLATFORM.GITHUB,
      teamId: state.installationId,
      userId: githubUser.id,
    },
    user.id
  );

  return htmlPage(
    'GitHub account linked',
    `GitHub account ${githubUser.login} has been linked to your Kilo account.<br>You can return to GitHub and mention Kilo again.`
  );
}

/**
 * GitHub App Installation Callback
 *
 * Called when user completes the GitHub App installation flow
 */
export async function GET(request: NextRequest) {
  try {
    // 1. Verify user authentication
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }

    // 2. Extract parameters
    const searchParams = request.nextUrl.searchParams;
    const installationId = searchParams.get('installation_id') ?? '';
    const setupAction = searchParams.get('setup_action');
    const rawState = searchParams.get('state');

    // 3. New database-backed install state — atomically consume the token.
    // Consumed before any other dispatch so a minted token is unambiguous:
    // even if a random base64url token's shape began with a legacy org_/user_
    // prefix, the DB row wins and the state is never misrouted to legacy or
    // bot-link parsing.
    if (rawState) {
      const installRow = await consumeInstallState(rawState);
      if (installRow) {
        return await handleNewInstallFlow(request, user, installRow, installationId, setupAction);
      }

      // 4. Legacy plaintext branch — starts with org_ or user_ prefix.
      // Legacy states are never bot-link or database-minted tokens.
      // They are accepted only when the GITHUB_LEGACY_INSTALL_STATE flag is enabled.
      if (rawState.startsWith('org_') || rawState.startsWith('user_')) {
        const legacyEnabled = (getEnvVariable('GITHUB_LEGACY_INSTALL_STATE') ?? 'true') !== 'false';

        if (legacyEnabled) {
          // ponytail: the legacy branch is deleted once the legacy-state counter
          // reports zero for 30 consecutive days.
          captureMessage('GitHub callback using legacy plaintext install state', {
            level: 'info',
            tags: { endpoint: 'github/callback', source: 'legacy_install_state' },
            extra: { installationId, stateClass: classifyInstallState(rawState) },
          });
          return await handleLegacyInstallFlow(
            request,
            user,
            rawState,
            installationId,
            setupAction
          );
        }

        // Legacy flag disabled: refuse the legacy state.
        captureMessage('GitHub callback with legacy state refused (flag disabled)', {
          level: 'warning',
          tags: { endpoint: 'github/callback', source: 'legacy_install_state_disabled' },
          extra: { installationId, stateClass: classifyInstallState(rawState) },
        });
        return NextResponse.redirect(new URL('/', APP_URL));
      }

      // 5. Bot-link callback hand-off. Bot-link state tokens use a signed
      // dot-separated format and never collide with database tokens, which are
      // base64url (no dots). Tried last, after DB and legacy dispatch.
      const botLinkState = verifyGitHubBotLinkState(rawState);
      if (botLinkState) {
        return await handleGitHubBotLinkCallback(request, user);
      }
    }

    // 6. Both bot-link and database consume returned null.
    captureMessage('GitHub callback with unrecognized state', {
      level: 'warning',
      tags: { endpoint: 'github/callback', source: 'github_app_installation' },
      extra: {
        installationId,
        setupAction,
        stateClass: classifyInstallState(rawState),
        reason: 'state_not_bot_link_or_install_token',
      },
    });
    return NextResponse.redirect(new URL('/', APP_URL));
  } catch (error) {
    console.error('Error handling GitHub App callback:', error);

    const searchParams = request.nextUrl.searchParams;
    const rawState = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'github/callback',
        source: 'github_app_installation',
      },
      extra: {
        installationId: searchParams.get('installation_id'),
        setupAction: searchParams.get('setup_action'),
        stateClass: classifyInstallState(rawState),
        reason: 'callback_flow_error',
      },
    });

    const { ownerToken: errorOwnerToken, returnTo } = parseStateReturn(rawState);

    let redirectPath = returnTo || '/';

    if (!returnTo && errorOwnerToken.startsWith('org_')) {
      const orgId = errorOwnerToken.slice(4);
      redirectPath = `/organizations/${orgId}/integrations/github`;
    } else if (!returnTo && errorOwnerToken.startsWith('user_')) {
      redirectPath = `/integrations/github`;
    }

    return NextResponse.redirect(
      new URL(appendQueryParam(redirectPath, 'error=installation_failed'), APP_URL)
    );
  }
}

/**
 * New database-backed install flow. The state was atomically consumed.
 * Verify the user matches and run the install flow using row data.
 */
async function handleNewInstallFlow(
  request: NextRequest,
  user: { id: string; google_user_email: string; google_user_name: string },
  installRow: GitHubInstallState,
  installationId: string,
  setupAction: string | null
): Promise<Response> {
  // Verify user identity — a state minted for another user must never be usable.
  if (installRow.kilo_user_id !== user.id) {
    captureMessage('GitHub install state consumed by different user', {
      level: 'warning',
      tags: { endpoint: 'github/callback', source: 'install_state_user_mismatch' },
      extra: {
        tokenUserId: installRow.kilo_user_id,
        callbackUserId: user.id,
        installationId,
      },
    });
    // Redirect to the integration page with a specific error so the UI can
    // display the corrective message.  If the flow was started from the app
    // (return_to is set to an app route like /cloud/sessions) include fromApp=1
    // so the /github-app fallback triggers.
    const returnTo = installRow.return_to;
    const isAppInitiated = returnTo?.startsWith('/cloud/') === true;
    const organizationId =
      installRow.owner_type === 'org' ? `&organizationId=${installRow.owner_id}` : '';
    const mismatchQuery = isAppInitiated
      ? `error=install_state_user_mismatch&fromApp=1${organizationId}`
      : 'error=install_state_user_mismatch';
    return NextResponse.redirect(new URL(appendQueryParam('/github-app', mismatchQuery), APP_URL));
  }

  const ownerType = installRow.owner_type as Owner['type'];
  const ownerId = installRow.owner_id;
  const owner: Owner = { type: ownerType, id: ownerId };
  const returnTo = installRow.return_to;

  return handleCoreInstallFlow({
    request,
    user,
    owner,
    ownerId,
    returnTo,
    installationId,
    setupAction,
    githubAppType: installRow.github_app_type as GitHubAppType,
  });
}

/**
 * Legacy plaintext install flow. Parses owner from the org_/user_ prefix.
 * Gated by GITHUB_LEGACY_INSTALL_STATE flag.
 */
async function handleLegacyInstallFlow(
  request: NextRequest,
  user: { id: string; google_user_email: string; google_user_name: string },
  rawState: string,
  installationId: string,
  setupAction: string | null
): Promise<Response> {
  // Parse owner from state (with optional |return=<path> suffix)
  const { ownerToken, returnTo } = parseStateReturn(rawState);
  let owner: Owner;
  let ownerId: string;

  if (ownerToken.startsWith('org_')) {
    ownerId = ownerToken.slice(4);
    owner = { type: 'org', id: ownerId };
  } else if (ownerToken.startsWith('user_')) {
    ownerId = ownerToken.slice(5);
    owner = { type: 'user', id: ownerId };
  } else {
    captureMessage('GitHub callback missing or invalid owner in state', {
      level: 'warning',
      tags: { endpoint: 'github/callback', source: 'github_app_installation' },
      extra: {
        installationId,
        stateClass: classifyInstallState(rawState),
        reason: 'owner_not_org_or_user_prefix',
      },
    });
    return NextResponse.redirect(new URL('/', APP_URL));
  }

  const appType = await getGitHubAppTypeForOrganization(owner.type === 'org' ? owner.id : null);

  return handleCoreInstallFlow({
    request,
    user,
    owner,
    ownerId,
    returnTo,
    installationId,
    setupAction,
    githubAppType: appType,
  });
}

/**
 * Core install flow shared by both legacy and new branches.
 * Handles access checks, pending approval, and installation storage.
 */
async function handleCoreInstallFlow(params: {
  request: NextRequest;
  user: { id: string; google_user_email: string; google_user_name: string };
  owner: Owner;
  ownerId: string;
  returnTo: string | null;
  installationId: string;
  setupAction: string | null;
  githubAppType: GitHubAppType;
}): Promise<Response> {
  const { user, owner, ownerId, returnTo, installationId, setupAction, githubAppType } = params;
  const searchParams = params.request.nextUrl.searchParams;

  // Verify user has access to the owner
  if (owner.type === 'org') {
    await ensureOrganizationAccess({ user: user as unknown as User }, owner.id);
  } else {
    if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/', APP_URL));
    }
  }

  const integrationPath =
    owner.type === 'org'
      ? `/organizations/${owner.id}/integrations/github`
      : `/integrations/github`;
  const redirectPath = returnTo || integrationPath;

  // App-initiated flows carry returnTo="/cloud/sessions".  A server redirect
  // does not always open the app, so redirect to /github-app where the
  // fallback card renders the outcome and a user-initiated "Return to Kilo
  // App" link that reliably triggers the universal link.
  const isAppInitiated = returnTo?.startsWith('/cloud/') === true;
  const appFallbackPath = (query: string) => {
    const organizationParam =
      owner.type === 'org' ? `&organizationId=${encodeURIComponent(ownerId)}` : '';
    return `/github-app?fromApp=1&${query}${organizationParam}`;
  };

  const credentials = getGitHubAppCredentials(githubAppType);

  // Handle uninstall/suspend actions
  if (setupAction === 'delete' || setupAction === 'suspend') {
    console.log(`GitHub App ${setupAction} action detected, skipping installation fetch`);

    return NextResponse.redirect(
      new URL(appendQueryParam(redirectPath, `github_action=${setupAction}`), APP_URL)
    );
  }

  // Handle pending approval - store requester info for webhook matching
  if (setupAction === 'request') {
    const code = searchParams.get('code');

    try {
      let githubRequester: { id: string; login: string } | undefined;

      if (code) {
        try {
          const githubUser = await exchangeGitHubOAuthCode(code, githubAppType);
          githubRequester = { id: githubUser.id, login: githubUser.login };

          console.log('GitHub user fetched', {
            github_user_id: githubRequester.id,
            github_user_login: githubRequester.login,
          });
        } catch (error) {
          console.error('Error fetching GitHub user:', error);
          captureException(error);
        }
      }

      let githubRequest: { id: string; accountId: string; accountLogin: string } | undefined;
      if (githubRequester) {
        const requests = await fetchGitHubInstallationRequests(githubAppType);
        const requesterRequests = requests.filter(
          request => request.requesterId === githubRequester.id
        );
        const recorded = await db
          .select({ platformAccountId: platform_integrations.platform_account_id })
          .from(platform_integrations)
          .where(
            and(
              eq(platform_integrations.platform, 'github'),
              eq(platform_integrations.github_app_type, githubAppType),
              eq(platform_integrations.integration_status, 'pending'),
              isNull(platform_integrations.platform_installation_id)
            )
          );
        const recordedAccountIds = new Set(recorded.map(row => row.platformAccountId));
        const unrecorded = requesterRequests.filter(
          request => !recordedAccountIds.has(request.accountId)
        );
        if (unrecorded.length === 1) {
          githubRequest = unrecorded[0];
        } else if (requesterRequests.length === 1) {
          const existing = requesterRequests[0];
          const [existingPending] = await db
            .select({ id: platform_integrations.id })
            .from(platform_integrations)
            .where(
              and(
                owner.type === 'org'
                  ? eq(platform_integrations.owned_by_organization_id, owner.id)
                  : eq(platform_integrations.owned_by_user_id, owner.id),
                eq(platform_integrations.platform, 'github'),
                eq(platform_integrations.github_app_type, githubAppType),
                eq(platform_integrations.platform_account_id, existing.accountId),
                eq(platform_integrations.integration_status, 'pending'),
                isNull(platform_integrations.platform_installation_id)
              )
            )
            .limit(1);
          if (existingPending) {
            githubRequest = existing;
          }
        }
      }

      if (githubRequest) {
        const [existingPending] = await db
          .select({ id: platform_integrations.id })
          .from(platform_integrations)
          .where(
            and(
              owner.type === 'org'
                ? eq(platform_integrations.owned_by_organization_id, owner.id)
                : eq(platform_integrations.owned_by_user_id, owner.id),
              eq(platform_integrations.platform, 'github'),
              eq(platform_integrations.github_app_type, githubAppType),
              eq(platform_integrations.platform_account_id, githubRequest.accountId),
              eq(platform_integrations.integration_status, 'pending'),
              isNull(platform_integrations.platform_installation_id)
            )
          )
          .limit(1);
        if (!existingPending) {
          await createPendingIntegration({
            organizationId: owner.type === 'org' ? owner.id : undefined,
            userId: owner.type === 'user' ? owner.id : undefined,
            requester: {
              kilo_user_id: user.id,
              kilo_user_email: user.google_user_email,
              kilo_user_name: user.google_user_name,
              requested_at: new Date().toISOString(),
            },
            githubRequester,
            githubRequest,
            githubAppType,
          });
        }
      }

      const orgParam =
        isAppInitiated && owner.type === 'org'
          ? `&organizationId=${encodeURIComponent(ownerId)}`
          : '';
      const queryParam = isAppInitiated
        ? `fromApp=1&github_pending_approval=true${orgParam}`
        : returnTo
          ? 'github_pending_approval=true'
          : 'pending_approval=true';

      const pendingRedirectPath = isAppInitiated ? '/github-app' : redirectPath;
      return NextResponse.redirect(
        new URL(appendQueryParam(pendingRedirectPath, queryParam), APP_URL)
      );
    } catch (error) {
      console.error('Error creating pending installation:', error);
      captureException(error);

      if (isAppInitiated) {
        return NextResponse.redirect(
          new URL(appFallbackPath('error=pending_setup_failed'), APP_URL)
        );
      }
      return NextResponse.redirect(
        new URL(appendQueryParam(redirectPath, 'error=pending_setup_failed'), APP_URL)
      );
    }
  }

  // Validate installation_id is present for normal install action
  if (!installationId) {
    captureMessage('GitHub callback missing installation_id', {
      level: 'warning',
      tags: { endpoint: 'github/callback', source: 'github_app_installation' },
      extra: {
        setupAction,
        stateClass: classifyInstallState(searchParams.get('state')),
        reason: 'missing_installation_id',
      },
    });

    if (isAppInitiated) {
      return NextResponse.redirect(
        new URL(appFallbackPath('error=missing_installation_id'), APP_URL)
      );
    }
    return NextResponse.redirect(
      new URL(appendQueryParam(redirectPath, 'error=missing_installation_id'), APP_URL)
    );
  }

  // Admin proof — report mode. The GitHub App does not yet request OAuth
  // authorization during installation. When `code` is present we verify
  // administration and log the outcome; when absent we log and proceed.
  // A follow-up commit will hard-require `code` after the App setting is
  // enabled in the GitHub App dashboard.
  if (setupAction === 'install' || setupAction === 'update') {
    const code = searchParams.get('code');

    if (code) {
      try {
        const exchangeResult = await exchangeGitHubOAuthCode(code, githubAppType);
        const isAdmin = await assertUserAdministersInstallation({
          accessToken: exchangeResult.accessToken,
          installationId,
        });

        if (isAdmin) {
          console.log('[github_admin_proof:pass]', {
            github_user_id: exchangeResult.id,
            github_user_login: exchangeResult.login,
            installation_id: installationId,
          });
        } else {
          console.log('[github_admin_proof:fail_non_admin]', {
            github_user_id: exchangeResult.id,
            github_user_login: exchangeResult.login,
            installation_id: installationId,
          });
        }
      } catch (error) {
        console.error('[github_admin_proof:error]', {
          installation_id: installationId,
          error: (error as Error).message,
        });
        captureException(error, {
          tags: {
            endpoint: 'github/callback',
            source: 'github_admin_proof',
          },
          extra: { installationId },
        });
      }
    } else {
      console.log('[github_admin_proof:code_absent]', {
        installation_id: installationId,
        setup_action: setupAction,
      });
    }
  }

  // Fetch installation details from GitHub
  const auth = createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  });

  const appAuth = await auth({ type: 'app' });
  const octokitApp = new Octokit({
    auth: appAuth.token,
  });

  let installation;
  try {
    console.log('Fetching installation details for ID:', installationId);
    const result = await octokitApp.apps.getInstallation({
      installation_id: parseInt(installationId),
    });
    installation = result.data;
  } catch (error) {
    const err = error as { message?: string; status?: number };

    captureException(error, {
      tags: {
        endpoint: 'github/callback',
        source: 'github_api_get_installation',
        status: err.status?.toString() || 'unknown',
      },
      extra: {
        installationId,
        ownerId,
        ownerType: owner.type,
        setupAction,
        errorStatus: err.status,
        errorMessage: err.message,
      },
    });

    if (err.status === 404) {
      const encodedInstallationId = encodeURIComponent(installationId);

      if (isAppInitiated) {
        return NextResponse.redirect(
          new URL(appFallbackPath('error=installation_not_found'), APP_URL)
        );
      }
      return NextResponse.redirect(
        new URL(
          appendQueryParam(
            redirectPath,
            `error=installation_not_found&id=${encodedInstallationId}`
          ),
          APP_URL
        )
      );
    }

    if (isAppInitiated) {
      return NextResponse.redirect(new URL(appFallbackPath('error=installation_failed'), APP_URL));
    }
    throw error;
  }

  // Get selected repositories
  let repositories: PlatformRepository[] | null = null;
  if (installation.repository_selection === 'selected') {
    console.log('Fetching repositories for installation:', installationId);
    const installationAuth = await auth({
      type: 'installation',
      installationId: parseInt(installationId),
    });
    const octokitInstallation = new Octokit({
      auth: installationAuth.token,
    });

    const { data: reposData } = await octokitInstallation.apps.listReposAccessibleToInstallation();
    repositories = reposData.repositories.map(repo => ({
      id: repo.id,
      name: repo.name,
      full_name: repo.full_name,
      private: repo.private,
    }));
  }

  // Store installation in database
  if (setupAction === 'install' || setupAction === 'update') {
    if (!installation.account) {
      throw new Error('Installation account is missing');
    }

    const account = installation.account;
    const accountId = account.id.toString();
    const accountLogin =
      'login' in account ? account.login : 'slug' in account ? account.slug : accountId;

    const upsertResult = await upsertPlatformIntegrationForOwner(owner, {
      platform: 'github',
      integrationType: 'app',
      platformInstallationId: installationId,
      platformAccountId: accountId,
      platformAccountLogin: accountLogin,
      permissions: installation.permissions as IntegrationPermissions,
      scopes: installation.events || [],
      repositoryAccess: installation.repository_selection,
      repositories: repositories && repositories.length > 0 ? repositories : null,
      installedAt: installation.created_at
        ? new Date(installation.created_at).toISOString()
        : new Date().toISOString(),
      githubAppType,
    });

    if (!upsertResult.ok) {
      if (isAppInitiated) {
        return NextResponse.redirect(
          new URL(appFallbackPath('error=installation_already_claimed'), APP_URL)
        );
      }
      return NextResponse.redirect(
        new URL(appendQueryParam(redirectPath, 'error=installation_already_claimed'), APP_URL)
      );
    }
  }

  // Redirect to success page
  if (isAppInitiated) {
    return NextResponse.redirect(new URL(appFallbackPath('github_install=success'), APP_URL));
  }
  const successQueryParam = returnTo ? 'github_install=success' : 'success=installed';

  return NextResponse.redirect(new URL(appendQueryParam(redirectPath, successQueryParam), APP_URL));
}
