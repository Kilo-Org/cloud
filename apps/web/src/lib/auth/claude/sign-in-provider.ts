import 'server-only';
import type { OAuthConfig } from 'next-auth/providers/oauth';
import type { Profile } from 'next-auth';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import {
  CLAUDE_CLIENT_ASSERTION_TYPE,
  CLAUDE_DISCOVERY_URL,
  CLAUDE_OIDC_ISSUER,
  CLAUDE_SIGN_IN_ASSERTION_AUDIENCE,
  CLAUDE_SIGN_IN_CLIENT_ID,
  CLAUDE_SIGN_IN_SCOPE,
  CLAUDE_TOKEN_URL,
} from '@kilocode/web-shared/lib/auth/claude/config';
import {
  CLAUDE_CLIENT_ASSERTION_LIFETIME_SECONDS,
  signClaudeFederationJwt,
} from '@kilocode/web-shared/lib/auth/claude/federation-jwt';

const ID_TOKEN_ALGORITHM = 'ES256';

const claudeProfileSchema = z.object({
  sub: z.string().trim().min(1),
  email: z.email(),
  name: z.string().nullish(),
});

/**
 * Maps the verified Claude ID-token claims to a NextAuth user. `sub` is
 * pairwise: it is stable for this OAuth app only, so it is the account binding.
 * The email is required because the sign-in requests the `email` scope.
 */
export function parseClaudeProfile(profile: unknown) {
  const parsed = claudeProfileSchema.parse(profile);
  return {
    id: parsed.sub,
    email: parsed.email,
    name: parsed.name?.trim() || parsed.email.split('@')[0],
    image: null,
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
  id_token: z.string().min(1),
});

const oauthErrorSchema = z.object({ error: z.string().min(1) });

export class ClaudeSignInError extends Error {
  override readonly name = 'ClaudeSignInError';
}

type ExchangeCodeInput = {
  code: string;
  codeVerifier: string;
  redirectUri: string;
};

/**
 * Redeems the authorization code at auth.claude.com. The token endpoint takes a
 * JSON body and authenticates the app with a Kilo-signed client assertion in
 * place of a client secret.
 */
export async function exchangeClaudeSignInCode({
  code,
  codeVerifier,
  redirectUri,
}: ExchangeCodeInput): Promise<z.infer<typeof tokenResponseSchema>> {
  const response = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: CLAUDE_SIGN_IN_CLIENT_ID,
      client_assertion_type: CLAUDE_CLIENT_ASSERTION_TYPE,
      client_assertion: await signClaudeFederationJwt({
        audience: CLAUDE_SIGN_IN_ASSERTION_AUDIENCE,
        lifetimeSeconds: CLAUDE_CLIENT_ASSERTION_LIFETIME_SECONDS,
      }),
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    // Only the OAuth error code is surfaced: the body can echo request values.
    const oauthError = oauthErrorSchema.safeParse(body);
    throw new ClaudeSignInError(
      `Claude token exchange failed with HTTP ${response.status}${oauthError.success ? ` (${oauthError.data.error})` : ''}`
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new ClaudeSignInError('Claude token response is malformed');
  }
  return parsed.data;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function remoteKeySet(jwksUri: string): JWTVerifyGetKey {
  let keySet = remoteKeySets.get(jwksUri);
  if (!keySet) {
    keySet = createRemoteJWKSet(new URL(jwksUri));
    remoteKeySets.set(jwksUri, keySet);
  }
  return keySet;
}

type VerifyIdTokenInput = {
  idToken: string;
  jwksUri: string;
  nonce: string;
};

/**
 * Verifies the ID token's ES256 signature against the discovery document's
 * JWKS, its issuer, its audience (the sign-in client ID), its expiry, and the
 * nonce the authorization request sent.
 */
export async function verifyClaudeIdToken({ idToken, jwksUri, nonce }: VerifyIdTokenInput) {
  const { payload } = await jwtVerify(idToken, remoteKeySet(jwksUri), {
    issuer: CLAUDE_OIDC_ISSUER,
    audience: CLAUDE_SIGN_IN_CLIENT_ID,
    algorithms: [ID_TOKEN_ALGORITHM],
    requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
  });
  if (payload.nonce !== nonce) {
    throw new ClaudeSignInError('Claude ID token nonce does not match');
  }
  return payload;
}

/**
 * "Sign in with Claude". NextAuth builds the authorization request from the
 * discovery document and keeps the state, PKCE verifier and nonce in its check
 * cookies. The code exchange is custom: auth.claude.com takes a JSON body and a
 * client assertion, which openid-client cannot send, so openid-client never
 * calls the token endpoint (`token_endpoint_auth_method: 'none'`) and the ID
 * token is verified here before NextAuth reads its claims.
 */
export const claudeSignInProvider: OAuthConfig<Profile> = {
  id: 'claude',
  name: 'Claude',
  type: 'oauth',
  wellKnown: CLAUDE_DISCOVERY_URL,
  issuer: CLAUDE_OIDC_ISSUER,
  idToken: true,
  checks: ['pkce', 'state', 'nonce'],
  client: {
    token_endpoint_auth_method: 'none',
    id_token_signed_response_alg: ID_TOKEN_ALGORITHM,
  },
  clientId: CLAUDE_SIGN_IN_CLIENT_ID,
  authorization: { params: { scope: CLAUDE_SIGN_IN_SCOPE } },
  token: {
    async request({ params, checks, client, provider }) {
      if (!params.code) throw new ClaudeSignInError('Claude callback has no authorization code');
      // A custom token exchange replaces openid-client's callback, including
      // its comparison of the returned state with the authenticated cookie.
      if (!checks.state || params.state !== checks.state) {
        throw new ClaudeSignInError('Claude callback state does not match');
      }
      // NextAuth types the checks as a union of the OAuth and OpenID shapes;
      // only the OpenID shape carries the nonce this provider always sends.
      const nonce = 'nonce' in checks ? checks.nonce : undefined;
      if (!checks.code_verifier || !nonce) {
        throw new ClaudeSignInError('Claude sign-in checks are missing');
      }
      const jwksUri = client.issuer.metadata.jwks_uri;
      if (!jwksUri) throw new ClaudeSignInError('Claude discovery document has no jwks_uri');
      if (!provider.callbackUrl) throw new ClaudeSignInError('Claude callback URL is not set');

      const tokens = await exchangeClaudeSignInCode({
        code: params.code,
        codeVerifier: checks.code_verifier,
        redirectUri: provider.callbackUrl,
      });
      await verifyClaudeIdToken({ idToken: tokens.id_token, jwksUri, nonce });

      return {
        tokens: {
          access_token: tokens.access_token,
          token_type: tokens.token_type,
          id_token: tokens.id_token,
          expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
          ...(tokens.scope ? { scope: tokens.scope } : {}),
        },
      };
    },
  },
  profile: parseClaudeProfile,
};
