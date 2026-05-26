import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { captureException, captureMessage } from '@sentry/nextjs';
import { LinearClient } from '@linear/sdk';
import {
  exchangeLinearOAuthCode,
  fetchLinearOAuthIdentity,
  LINEAR_REDIRECT_URI,
  LinearWorkspaceAlreadyConnectedError,
  type LinearOAuthIdentity,
  revokeLinearToken,
  upsertLinearInstallation,
} from '@/lib/integrations/linear-service';
import { verifyOAuthState } from '@/lib/integrations/oauth-state';
import { APP_URL } from '@/lib/constants';
import { bot } from '@/lib/bot';
import { linkKiloUser, unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { PLATFORM } from '@/lib/integrations/core/constants';
import {
  type VerifiedLinearBotLinkState,
  verifyLinearBotLinkState,
} from '@/lib/bot/linear-link-state';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegrationById,
} from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import {
  appendIntegrationOAuthRedirectQuery,
  buildIntegrationOAuthRedirectPath,
  buildIntegrationOAuthRedirectPathFromOwner,
  parseOAuthStateOwner,
} from '@/lib/integrations/oauth/common';

async function getChatSdkLinearAccessToken(organizationId: string): Promise<string | null> {
  const installation = await bot.getAdapter('linear').getInstallation(organizationId);
  return installation?.accessToken ?? null;
}

async function deleteChatSdkLinearInstallation(organizationId: string): Promise<void> {
  await bot.getAdapter('linear').deleteInstallation(organizationId);
}

async function deleteChatSdkLinearIdentityCache(organizationId: string): Promise<void> {
  await unlinkTeamKiloUsers(bot.getState(), PLATFORM.LINEAR, organizationId);
}

/**
 * Fetch the workspace name for a freshly installed Linear installation by
 * querying Linear's `organization` GraphQL field with the freshly-issued
 * access token. We cannot use `linearAdapter.getUser('me')` for this: with
 * `actor=app` installs (which is what `getLinearOAuthUrl` uses), the
 * authenticated viewer is the app actor — the configured `userName`
 * (`'kilo'` / `'kilo-dev'`) — not the human installer or the workspace.
 *
 * Falls back to the organizationId on failure so the install still succeeds
 * with a human-readable label.
 */
async function fetchLinearWorkspaceName(
  accessToken: string,
  organizationId: string
): Promise<string> {
  try {
    const organization = await new LinearClient({ accessToken }).organization;
    return organization.name || organization.urlKey || organizationId;
  } catch (error) {
    captureMessage('Failed to fetch Linear workspace name', {
      level: 'warning',
      tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
      extra: { organizationId, error: error instanceof Error ? error.message : String(error) },
    });
    return organizationId;
  }
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

/**
 * Handle the Linear bot account-link callback. The state was signed by
 * `/linear/link` and carries the Kilo user id, the platform integration
 * id, and the Linear organization id we expect the OAuth viewer to
 * belong to. The clicker's Linear identity comes exclusively from
 * `viewer { id }` queried with the freshly-issued user-actor token —
 * never from the URL — so the original Linear comment author cannot be
 * impersonated by another workspace member.
 */
async function handleLinearBotLinkCallback(
  request: NextRequest,
  user: { id: string },
  state: VerifiedLinearBotLinkState
): Promise<Response> {
  const searchParams = request.nextUrl.searchParams;
  const error = searchParams.get('error');
  const code = searchParams.get('code');

  if (error) {
    // Don't echo the raw `error` value into the HTML body — it's a third-party-
    // controlled string and `htmlPage` does not escape its message argument.
    // The raw value is logged to Sentry for debugging.
    captureMessage('Linear bot-link OAuth error', {
      level: 'warning',
      tags: { endpoint: 'linear/callback', source: 'linear_bot_link' },
      extra: { error },
    });
    return htmlPage(
      'Link Failed',
      'Linear returned an OAuth error. Please return to Linear and try again.',
      400
    );
  }

  if (!code) {
    return htmlPage(
      'Link Failed',
      'Linear did not return an authorization code. Please try again.',
      400
    );
  }

  if (state.userId !== user.id) {
    return htmlPage(
      'Link Failed',
      'This Linear link request was started by another Kilo user.',
      403
    );
  }

  const integration = await getPlatformIntegrationById(state.platformIntegrationId).catch(
    () => null
  );

  if (!integration) {
    return htmlPage('Link Failed', 'No matching Linear integration was found.', 404);
  }

  if (
    integration.platform !== PLATFORM.LINEAR ||
    integration.platform_installation_id !== state.organizationId
  ) {
    return htmlPage('Link Failed', 'No matching Linear integration was found.', 404);
  }

  if (!botPlatforms.require(PLATFORM.LINEAR).isEnabledForBot(integration)) {
    return htmlPage('Link Unavailable', 'Linear linking is not enabled for this integration.', 404);
  }

  if (!(await canKiloUserAccessPlatformIntegration(integration, user.id))) {
    return htmlPage('Link Failed', 'You do not have access to this Linear integration.', 403);
  }

  const tokenResponse = await exchangeLinearOAuthCode(code);
  const accessToken = tokenResponse.accessToken;
  const refreshToken = tokenResponse.refreshToken;

  try {
    const identity: LinearOAuthIdentity = await fetchLinearOAuthIdentity(accessToken);

    if (identity.organizationId !== state.organizationId) {
      // The clicker authenticated against a different Linear workspace than
      // the one the link token was issued for.
      return htmlPage(
        'Link Failed',
        'You signed into a different Linear workspace than the one this link was issued for.',
        403
      );
    }

    await bot.initialize();
    await linkKiloUser(
      bot.getState(),
      {
        platform: PLATFORM.LINEAR,
        teamId: identity.organizationId,
        userId: identity.viewerId,
      },
      user.id
    );

    return htmlPage(
      'Linear account linked',
      'Your Linear account has been linked to your Kilo account.<br>You can return to Linear and mention Kilo again.'
    );
  } finally {
    // Best-effort revoke of every transient token Linear handed back. We
    // only need these tokens as proof-of-workspace-membership; they serve
    // no purpose once we've read `viewer { id, organization { id } }`. Run
    // in `finally` so a failure in `bot.initialize()` / `linkKiloUser()` (or
    // anywhere else after the exchange) still drops the proof tokens.
    // Failures are already logged by `revokeLinearToken`; do not fail the
    // page on them.
    await revokeLinearToken(accessToken, 'access_token');
    if (refreshToken) {
      await revokeLinearToken(refreshToken, 'refresh_token');
    }
  }
}

/**
 * Linear OAuth callback.
 */
export async function handleLinearOAuthCallback(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    const searchParams = request.nextUrl.searchParams;

    // Bot-link branch: dispatch on the discriminator-bearing state shape
    // BEFORE running install-flow logic. The two HMACs are over different
    // payload shapes, so verifyOAuthState returns null for bot-link states
    // and verifyLinearBotLinkState returns null for install states.
    const botLinkState = verifyLinearBotLinkState(searchParams.get('state'));
    if (botLinkState) {
      return await handleLinearBotLinkCallback(request, user, botLinkState);
    }

    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const error = searchParams.get('error');

    // Verify the state signature once up-front so subsequent redirects can
    // reuse the resulting owner string without re-running HMAC verification
    // on every error branch.
    const verified = state ? verifyOAuthState(state) : null;
    const verifiedOwner = verified?.owner ?? null;

    if (error) {
      captureMessage('Linear OAuth error', {
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: { error, state },
      });
      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromOwner(
            PLATFORM.LINEAR,
            verifiedOwner,
            `error=${encodeURIComponent(error)}`,
            verified?.returnTo
          ),
          APP_URL
        )
      );
    }

    if (!code) {
      captureMessage('Linear callback missing code', {
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: { state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(
        new URL(
          buildIntegrationOAuthRedirectPathFromOwner(
            PLATFORM.LINEAR,
            verifiedOwner,
            'error=missing_code',
            verified?.returnTo
          ),
          APP_URL
        )
      );
    }

    if (!verified) {
      captureMessage('Linear callback invalid or tampered state signature', {
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: { code: '***', state, allParams: Object.fromEntries(searchParams.entries()) },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (verified.userId !== user.id) {
      captureMessage('Linear callback user mismatch (possible CSRF)', {
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: { stateUserId: verified.userId, sessionUserId: user.id },
      });
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    const ownerStr = verified.owner;
    const owner = parseOAuthStateOwner(ownerStr);
    if (!owner) {
      captureMessage('Linear callback missing or invalid owner in state', {
        level: 'warning',
        tags: { endpoint: 'linear/callback', source: 'linear_oauth' },
        extra: { code: '***', owner: ownerStr },
      });
      return NextResponse.redirect(new URL('/integrations?error=invalid_state', APP_URL));
    }

    if (owner.type === 'org') {
      await ensureOrganizationAccess({ user }, owner.id);
    } else if (user.id !== owner.id) {
      return NextResponse.redirect(new URL('/integrations?error=unauthorized', APP_URL));
    }

    // Chat SDK exchanges the code, persists the per-workspace installation in
    // its state adapter, and returns the Linear organizationId + installation.
    await bot.initialize();
    const linearAdapter = bot.getAdapter('linear');
    const { organizationId, installation } = await linearAdapter.handleOAuthCallback(request, {
      redirectUri: LINEAR_REDIRECT_URI,
    });

    const workspaceName = await fetchLinearWorkspaceName(installation.accessToken, organizationId);

    try {
      await upsertLinearInstallation(
        {
          owner,
          organizationId,
          organizationName: workspaceName,
          botUserId: installation.botUserId,
        },
        {
          getChatSdkAccessToken: getChatSdkLinearAccessToken,
          deleteChatSdkInstallation: deleteChatSdkLinearInstallation,
          deleteChatSdkIdentityCache: deleteChatSdkLinearIdentityCache,
        }
      );
    } catch (error) {
      if (error instanceof LinearWorkspaceAlreadyConnectedError) {
        // The Chat SDK adapter already persisted the freshly-issued OAuth
        // token under linear:installation:${organizationId} during
        // handleOAuthCallback. Since the uniqueness check rejected this
        // install, we must roll that state back — otherwise we overwrite the
        // original installer's token and any future bot/webhook traffic for
        // that workspace runs with mismatched credentials.
        await linearAdapter.deleteInstallation(organizationId);
        await unlinkTeamKiloUsers(bot.getState(), PLATFORM.LINEAR, organizationId);
        return NextResponse.redirect(
          new URL(
            buildIntegrationOAuthRedirectPathFromOwner(
              PLATFORM.LINEAR,
              verifiedOwner,
              'error=workspace_already_connected',
              verified?.returnTo
            ),
            APP_URL
          )
        );
      }
      throw error;
    }

    const successPath = verified.returnTo
      ? appendIntegrationOAuthRedirectQuery(verified.returnTo, 'success=linear_installed')
      : buildIntegrationOAuthRedirectPath(PLATFORM.LINEAR, owner, 'success=installed');

    return NextResponse.redirect(new URL(successPath, APP_URL));
  } catch (error) {
    const searchParams = request.nextUrl.searchParams;
    const state = searchParams.get('state');
    const verified = state ? verifyOAuthState(state) : null;

    captureException(error, {
      tags: {
        endpoint: 'linear/callback',
        source: 'linear_oauth',
      },
      extra: {
        state,
        hasCode: !!searchParams.get('code'),
      },
    });

    return NextResponse.redirect(
      new URL(
        buildIntegrationOAuthRedirectPathFromOwner(
          PLATFORM.LINEAR,
          verified?.owner,
          'error=installation_failed',
          verified?.returnTo
        ),
        APP_URL
      )
    );
  }
}
