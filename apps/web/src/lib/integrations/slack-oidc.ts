import 'server-only';
import * as z from 'zod';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET } from '@kilocode/web-shared/lib/config.server';
import { captureException } from '@sentry/nextjs';
import { getPlatformOAuthCallbackUrl } from '@/lib/integrations/oauth/urls';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { LinkAccountProofUnavailableError } from '@/lib/bot/link-account-proof';

// "Sign in with Slack" (OpenID Connect) is how a browser proves which Slack
// user it is signed in to Slack as. It is separate from the bot-install OAuth
// flow: `scope=openid` only, and the token it returns is used once to read the
// caller's own identity and then discarded. The redirect URI is the Slack
// platform OAuth callback the app already registers, so enabling the `openid`
// user scope in the Slack app is the only configuration this flow needs.
//
// Slack's userinfo response stamps the identity as
// `https://slack.com/team_id` and `https://slack.com/user_id`.

const SLACK_OIDC_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_OIDC_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_OIDC_USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';
const SLACK_OIDC_REVOKE_URL = 'https://slack.com/api/auth.revoke';

const SLACK_OIDC_TIMEOUT_MS = 10_000;

const TEAM_ID_CLAIM = 'https://slack.com/team_id';
const USER_ID_CLAIM = 'https://slack.com/user_id';

export class SlackOidcNotConfiguredError extends LinkAccountProofUnavailableError {
  constructor() {
    super('Account linking is not available right now.');
    this.name = 'SlackOidcNotConfiguredError';
  }
}

export class SlackOidcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackOidcError';
  }
}

export type SlackIdentity = {
  teamId: string;
  userId: string;
};

const tokenResponseSchema = z.object({
  ok: z.boolean(),
  access_token: z.string().min(1).optional(),
});

const userInfoResponseSchema = z.object({
  ok: z.boolean(),
  [TEAM_ID_CLAIM]: z.string().min(1).optional(),
  [USER_ID_CLAIM]: z.string().min(1).optional(),
});

export function isSlackOidcConfigured(): boolean {
  return Boolean(SLACK_CLIENT_ID && SLACK_CLIENT_SECRET);
}

export function getSlackOidcRedirectUri(): string {
  return getPlatformOAuthCallbackUrl(PLATFORM.SLACK);
}

/**
 * Authorization URL for Sign in with Slack. `state` is the signed bot-link
 * state; Slack returns it unchanged to `getSlackOidcRedirectUri()`.
 */
export function getSlackOidcAuthorizeUrl(state: string): string {
  if (!SLACK_CLIENT_ID) {
    throw new SlackOidcNotConfiguredError();
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SLACK_CLIENT_ID,
    scope: 'openid',
    redirect_uri: getSlackOidcRedirectUri(),
    state,
  });

  return `${SLACK_OIDC_AUTHORIZE_URL}?${params.toString()}`;
}

async function slackRequest(
  url: string,
  init: RequestInit,
  operation: 'token' | 'userinfo' | 'revoke'
): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(SLACK_OIDC_TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!response.ok) {
    const error = new SlackOidcError(
      `Slack sign-in ${operation} failed with status ${response.status}`
    );
    captureException(error, {
      tags: { component: 'kilo-bot', op: `slack-oidc-${operation}` },
      extra: { status: response.status },
    });
    throw error;
  }

  try {
    return await response.json();
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: `slack-oidc-${operation}` },
      extra: { status: response.status },
    });
    throw new SlackOidcError(`Slack sign-in returned a non-JSON ${operation} response`);
  }
}

/**
 * Redeem the authorization code at Slack's OIDC token endpoint.
 *
 * The code was issued to our `client_id` for our registered redirect URI, so
 * the access token it yields is bound to this application and to the Slack user
 * who approved the request.
 */
export async function exchangeSlackOidcCode(code: string): Promise<string> {
  if (!SLACK_CLIENT_ID || !SLACK_CLIENT_SECRET) {
    throw new SlackOidcNotConfiguredError();
  }

  const body = await slackRequest(
    SLACK_OIDC_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SLACK_CLIENT_ID,
        client_secret: SLACK_CLIENT_SECRET,
        code,
        redirect_uri: getSlackOidcRedirectUri(),
      }).toString(),
    },
    'token'
  );

  const parsed = tokenResponseSchema.safeParse(body);
  const accessToken = parsed.success && parsed.data.ok ? parsed.data.access_token : undefined;

  if (!accessToken) {
    throw new SlackOidcError('Slack sign-in did not return an access token');
  }

  return accessToken;
}

/**
 * Read the signed-in Slack user's identity from Slack. `user_id` and `team_id`
 * are Slack's own assertions about the token holder: they are the identity this
 * flow links, and they must match the identity the pending link token named
 * before anything is written.
 */
export async function fetchSlackIdentity(accessToken: string): Promise<SlackIdentity> {
  const body = await slackRequest(
    SLACK_OIDC_USERINFO_URL,
    { headers: { authorization: `Bearer ${accessToken}` } },
    'userinfo'
  );

  const parsed = userInfoResponseSchema.safeParse(body);
  if (!parsed.success || !parsed.data.ok) {
    throw new SlackOidcError('Slack sign-in did not return a user identity');
  }

  const teamId = parsed.data[TEAM_ID_CLAIM];
  const userId = parsed.data[USER_ID_CLAIM];

  if (!teamId || !userId) {
    throw new SlackOidcError('Slack sign-in returned an incomplete user identity');
  }

  return { teamId, userId };
}

/** Best-effort token revocation; the token is single-use proof and short-lived. */
export async function revokeSlackOidcToken(accessToken: string): Promise<void> {
  try {
    await slackRequest(
      SLACK_OIDC_REVOKE_URL,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
      },
      'revoke'
    );
  } catch (error) {
    captureException(error, { tags: { component: 'kilo-bot', op: 'slack-oidc-revoke' } });
  }
}
