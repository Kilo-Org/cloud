import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { exchangeGitHubOAuthCode } from '@/lib/integrations/platforms/github/adapter';
import {
  getGitHubAppTypeForOrganization,
  getGitHubAppCredentials,
} from '@/lib/integrations/platforms/github/app-selector';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import {
  createPendingIntegration,
  findPendingInstallationByRequesterId,
  upsertPlatformIntegrationForOwner,
} from '@/lib/integrations/db/platform-integrations';
import type {
  PlatformRepository,
  IntegrationPermissions,
  Owner,
} from '@/lib/integrations/core/types';
import { captureException, captureMessage } from '@sentry/nextjs';

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
      // If user is not authenticated (e.g., GitHub admin approving installation),
      // redirect to homepage instead of showing "Unauthorized"
      return NextResponse.redirect(new URL('/', request.url));
    }

    // 2. Extract parameters
    const searchParams = request.nextUrl.searchParams;
    const installationId = searchParams.get('installation_id') ?? '';
    const setupAction = searchParams.get('setup_action');
    const state = searchParams.get('state'); // Contains owner info (org_ID or user_ID)

    // 3. Parse owner from state
    let owner: Owner;
    let ownerId: string;

    if (state?.startsWith('org_')) {
      ownerId = state.replace('org_', '');
      owner = { type: 'org', id: ownerId };
    } else if (state?.startsWith('user_')) {
      ownerId = state.replace('user_', '');
      owner = { type: 'user', id: ownerId };
    } else {
      captureMessage('GitHub callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'github/callback', source: 'github_app_installation' },
        extra: { installationId, state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/', request.url));
    }

    // 4. Verify user has access to the owner
    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else {
      // For user-owned integrations, verify it's the same user
      if (user.id !== owner.id) {
        return NextResponse.redirect(new URL('/', request.url));
      }
    }

    // 5. Determine which GitHub App to use based on organization settings
    const appType = await getGitHubAppTypeForOrganization(owner.type === 'org' ? owner.id : null);
    const credentials = getGitHubAppCredentials(appType);

    // Handle uninstall/suspend actions
    if (setupAction === 'delete' || setupAction === 'suspend') {
      console.log(`GitHub App ${setupAction} action detected, skipping installation fetch`);

      const redirectPath =
        owner.type === 'org'
          ? `/organizations/${owner.id}/integrations/github?action=${setupAction}`
          : `/integrations/github?action=${setupAction}`;

      return NextResponse.redirect(new URL(redirectPath, request.url));
    }

    // Handle pending approval - store requester info for webhook matching
    if (setupAction === 'request') {
      const code = searchParams.get('code');

      try {
        let githubRequester: { id: string; login: string } | undefined;

        // Exchange OAuth code for GitHub user identity
        if (code) {
          try {
            githubRequester = await exchangeGitHubOAuthCode(code, appType);

            console.log('GitHub user fetched', {
              github_user_id: githubRequester.id,
              github_user_login: githubRequester.login,
            });
          } catch (error) {
            console.error('Error fetching GitHub user:', error);
            captureException(error);
            // Continue without GitHub user info
          }
        }

        // Check for existing pending installation by this GitHub user
        if (githubRequester) {
          const existingPending = await findPendingInstallationByRequesterId(githubRequester.id);

          if (existingPending) {
            const existingOwnerId =
              existingPending.owned_by_organization_id || existingPending.owned_by_user_id;

            console.log('User already has a pending installation', {
              existingPendingId: existingPending.id,
              existingOwnerId,
              githubRequesterId: githubRequester.id,
            });

            const redirectPath =
              owner.type === 'org'
                ? `/organizations/${owner.id}/integrations/github?error=pending_installation_exists&org=${existingOwnerId}`
                : `/integrations/github?error=pending_installation_exists`;

            return NextResponse.redirect(new URL(redirectPath, request.url));
          }
        }

        // Create pending installation record with requester info
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
          githubAppType: appType,
        });

        // Redirect back to integrations page with pending approval status
        const redirectPath =
          owner.type === 'org'
            ? `/organizations/${owner.id}/integrations/github?pending_approval=true`
            : `/integrations/github?pending_approval=true`;

        return NextResponse.redirect(new URL(redirectPath, request.url));
      } catch (error) {
        console.error('Error creating pending installation:', error);
        captureException(error);

        const redirectPath =
          owner.type === 'org'
            ? `/organizations/${owner.id}/integrations/github?error=pending_setup_failed`
            : `/integrations/github?error=pending_setup_failed`;

        return NextResponse.redirect(new URL(redirectPath, request.url));
      }
    }

    // Validate installation_id is present for normal install action
    if (!installationId) {
      captureMessage('GitHub callback missing installation_id', {
        level: 'warning',
        tags: { endpoint: 'github/callback', source: 'github_app_installation' },
        extra: { setupAction, state, allParams: Object.fromEntries(searchParams.entries()) },
      });

      const redirectPath =
        owner.type === 'org'
          ? `/organizations/${owner.id}/integrations/github?error=missing_installation_id`
          : `/integrations/github?error=missing_installation_id`;

      return NextResponse.redirect(new URL(redirectPath, request.url));
    }

    // 6. Fetch installation details from GitHub
    // Create app authentication without installationId to get installation details
    const auth = createAppAuth({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    });

    // Get app-level JWT token to fetch installation details
    const appAuth = await auth({ type: 'app' });
    const octokitApp = new Octokit({
      auth: appAuth.token,
    });

    // Fetch installation details using app-level token
    let installation;
    try {
      console.log('Fetching installation details for ID:', installationId);
      const result = await octokitApp.apps.getInstallation({
        installation_id: parseInt(installationId),
      });
      installation = result.data;
    } catch (error) {
      const err = error as { message?: string; status?: number };

      // Capture to Sentry for monitoring
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

      // If installation not found, it might have been deleted or belongs to a different app
      if (err.status === 404) {
        const redirectPath =
          owner.type === 'org'
            ? `/organizations/${owner.id}/integrations/github?error=installation_not_found&id=${installationId}`
            : `/integrations/github?error=installation_not_found&id=${installationId}`;

        return NextResponse.redirect(new URL(redirectPath, request.url));
      }

      throw error;
    }

    // 7. Get selected repositories
    // For 'selected' repositories, we fetch the list. For 'all', we set it to null
    let repositories: PlatformRepository[] | null = null;
    if (installation.repository_selection === 'selected') {
      // Need to use installation token (not app token) to list repos
      console.log('Fetching repositories for installation:', installationId);
      const installationAuth = await auth({
        type: 'installation',
        installationId: parseInt(installationId),
      });
      const octokitInstallation = new Octokit({
        auth: installationAuth.token,
      });

      const { data: reposData } =
        await octokitInstallation.apps.listReposAccessibleToInstallation();
      repositories = reposData.repositories.map(repo => ({
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        private: repo.private,
      }));
    }

    // 8. Store installation in database using new platform_integrations table
    if (setupAction === 'install') {
      // Handle null account and union type (User | Organization)
      if (!installation.account) {
        throw new Error('Installation account is missing');
      }

      const account = installation.account;
      const accountId = account.id.toString();
      const accountLogin =
        'login' in account ? account.login : 'slug' in account ? account.slug : accountId;

      await upsertPlatformIntegrationForOwner(owner, {
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
        githubAppType: appType,
      });
    }

    // 9. Redirect to success page
    const successPath =
      owner.type === 'org'
        ? `/organizations/${owner.id}/integrations/github?success=installed`
        : `/integrations/github?success=installed`;

    return NextResponse.redirect(new URL(successPath, request.url));
  } catch (error) {
    console.error('Error handling GitHub App callback:', error);

    // Capture error to Sentry with context for debugging
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');

    captureException(error, {
      tags: {
        endpoint: 'github/callback',
        source: 'github_app_installation',
      },
      extra: {
        installationId: searchParams.get('installation_id'),
        setupAction: searchParams.get('setup_action'),
        state,
      },
    });

    // Determine redirect path based on state parameter
    let redirectPath = '/?error=installation_failed';

    if (state?.startsWith('org_')) {
      const orgId = state.replace('org_', '');
      redirectPath = `/organizations/${orgId}/integrations/github?error=installation_failed`;
    } else if (state?.startsWith('user_')) {
      redirectPath = `/integrations/github?error=installation_failed`;
    }

    return NextResponse.redirect(new URL(redirectPath, request.url));
  }
}
