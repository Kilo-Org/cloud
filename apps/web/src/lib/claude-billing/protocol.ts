import 'server-only';
import { z } from 'zod';
import {
  CLAUDE_AUTHORIZE_URL,
  CLAUDE_BILLING_ASSERTION_AUDIENCE,
  CLAUDE_BILLING_CLIENT_ID,
  CLAUDE_BILLING_CONNECTION_TYPE,
  CLAUDE_BILLING_SCOPE,
  CLAUDE_CLIENT_ASSERTION_TYPE,
  CLAUDE_PAR_URL,
  CLAUDE_TOKEN_URL,
} from '@kilocode/web-shared/lib/auth/claude/config';
import {
  CLAUDE_CLIENT_ASSERTION_LIFETIME_SECONDS,
  signClaudeFederationJwt,
} from '@kilocode/web-shared/lib/auth/claude/federation-jwt';
import { fetchClaudeWithRetry } from '@kilocode/web-shared/lib/auth/claude/http';

/**
 * The Linked billing with Claude Platform OAuth round trip: a pushed authorization
 * request, the approval redirect, and the code exchange that returns the
 * customer's connection ID.
 */

export class ClaudeBillingExchangeError extends Error {
  override readonly name = 'ClaudeBillingExchangeError';

  constructor(readonly oauthError: string | null) {
    super(`Claude billing exchange failed${oauthError ? ` (${oauthError})` : ''}`);
  }
}

async function clientAssertion() {
  return await signClaudeFederationJwt({
    audience: CLAUDE_BILLING_ASSERTION_AUDIENCE,
    lifetimeSeconds: CLAUDE_CLIENT_ASSERTION_LIFETIME_SECONDS,
  });
}

async function postJson(url: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetchClaudeWithRetry(
    url,
    async () => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...body, client_assertion: await clientAssertion() }),
    }),
    status => status === 429 || status >= 500,
    AbortSignal.timeout(15_000)
  );
  const parsed: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const oauthError = z.object({ error: z.string() }).safeParse(parsed);
    // Only the OAuth error code is surfaced: the body can echo request values.
    throw new ClaudeBillingExchangeError(oauthError.success ? oauthError.data.error : null);
  }
  return parsed;
}

const parResponseSchema = z.object({
  request_uri: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
});

type PushAuthorizationInput = {
  userProfileId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
};

/** Sends the pushed authorization request and returns the approval URL. */
export async function pushClaudeAuthorizationRequest({
  userProfileId,
  redirectUri,
  state,
  codeChallenge,
}: PushAuthorizationInput): Promise<string> {
  const parsed = parResponseSchema.parse(
    await postJson(CLAUDE_PAR_URL, {
      response_type: 'code',
      client_id: CLAUDE_BILLING_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CLAUDE_BILLING_SCOPE,
      connection_type: CLAUDE_BILLING_CONNECTION_TYPE,
      user_profile_id: userProfileId,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      client_assertion_type: CLAUDE_CLIENT_ASSERTION_TYPE,
    })
  );
  // The authorization endpoint takes only these two parameters.
  const query = new URLSearchParams({
    client_id: CLAUDE_BILLING_CLIENT_ID,
    request_uri: parsed.request_uri,
  });
  return `${CLAUDE_AUTHORIZE_URL}?${query.toString()}`;
}

const tokenResponseSchema = z.object({
  connection_id: z.string().min(1),
});

/** Exchanges the callback code for the customer's connection ID. */
export async function exchangeClaudeBillingCode({
  code,
  codeVerifier,
  redirectUri,
}: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<string> {
  const parsed = tokenResponseSchema.parse(
    await postJson(CLAUDE_TOKEN_URL, {
      grant_type: 'authorization_code',
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      client_id: CLAUDE_BILLING_CLIENT_ID,
      client_assertion_type: CLAUDE_CLIENT_ASSERTION_TYPE,
    })
  );
  return parsed.connection_id;
}
