import 'server-only';

import crypto from 'node:crypto';
import { APP_URL } from '@/lib/constants';
import { AGENTCARD_MCP_BASE_URL, AGENTCARD_OAUTH_CLIENT_ID } from '@/lib/config.server';

/**
 * AgentCard OAuth 2.1 client.
 *
 * AgentCard's MCP host (mcp.agentcard.sh) is a full OAuth 2.1 authorization
 * server: discovery at /.well-known/oauth-authorization-server, /authorize,
 * /token, /register (dynamic client registration), /revoke, PKCE (S256), and a
 * magic-link + consent flow. This module implements the third-party side of
 * the authorization-code + PKCE flow so Kilo can show a "Connect AgentCard"
 * button instead of asking users to paste a token.
 *
 * The client is a *public* client (token_endpoint_auth_method = "none"); there
 * is no client secret — security comes from PKCE + the registered redirect URI.
 */

export const AGENTCARD_OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;

/** The redirect URI Kilo registers and AgentCard redirects back to. */
export function agentCardRedirectUri(): string {
  return `${APP_URL}/api/integrations/agentcard/callback`;
}

function authorizeEndpoint(): string {
  return `${AGENTCARD_MCP_BASE_URL}/authorize`;
}

function tokenEndpoint(): string {
  return `${AGENTCARD_MCP_BASE_URL}/token`;
}

function registrationEndpoint(): string {
  return `${AGENTCARD_MCP_BASE_URL}/register`;
}

function revocationEndpoint(): string {
  return `${AGENTCARD_MCP_BASE_URL}/revoke`;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** Generate a high-entropy PKCE code verifier (RFC 7636: 43–128 chars). */
export function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Derive the S256 code challenge for a verifier. */
export function deriveCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

// ---------------------------------------------------------------------------
// Dynamic client registration
// ---------------------------------------------------------------------------

// Cache the registered client_id for the lifetime of the process so we don't
// register a new client on every connect. A pre-configured
// AGENTCARD_OAUTH_CLIENT_ID always wins.
let cachedClientId: string | null = AGENTCARD_OAUTH_CLIENT_ID || null;

type RegisterClientResponse = {
  client_id: string;
};

/**
 * Returns the OAuth client_id to use. Uses AGENTCARD_OAUTH_CLIENT_ID when set,
 * otherwise dynamically registers a public client with AgentCard (once per
 * process) for Kilo's callback redirect URI.
 */
export async function getOrRegisterClientId(): Promise<string> {
  if (cachedClientId) return cachedClientId;

  const res = await fetch(registrationEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Kilo',
      redirect_uris: [agentCardRedirectUri()],
      grant_types: [...AGENTCARD_OAUTH_GRANT_TYPES],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });

  if (!res.ok) {
    throw new Error(
      `AgentCard dynamic client registration failed (${res.status}): ${await res.text()}`
    );
  }

  const data = (await res.json()) as RegisterClientResponse;
  if (!data.client_id) {
    throw new Error('AgentCard registration response missing client_id');
  }

  cachedClientId = data.client_id;
  return cachedClientId;
}

// ---------------------------------------------------------------------------
// Authorization + token exchange
// ---------------------------------------------------------------------------

export function buildAgentCardOAuthUrl(args: {
  state: string;
  codeChallenge: string;
  clientId: string;
}): string {
  const url = new URL(authorizeEndpoint());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', agentCardRedirectUri());
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', args.state);
  return url.toString();
}

export type AgentCardTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry as an ISO string, derived from expires_in. */
  expiresAt: string | null;
  scopes: string[];
};

type RawTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
};

function parseTokenResponse(raw: RawTokenResponse): AgentCardTokenSet {
  if (!raw.access_token) {
    throw new Error('AgentCard token response missing access_token');
  }
  const expiresAt =
    typeof raw.expires_in === 'number'
      ? new Date(Date.now() + raw.expires_in * 1000).toISOString()
      : null;
  const scopes = raw.scope ? [...new Set(raw.scope.split(/\s+/).filter(Boolean))].sort() : [];
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    expiresAt,
    scopes,
  };
}

async function postToken(body: URLSearchParams): Promise<AgentCardTokenSet> {
  const res = await fetch(tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`AgentCard token request failed (${res.status}): ${await res.text()}`);
  }
  return parseTokenResponse((await res.json()) as RawTokenResponse);
}

/** Exchange an authorization code (+ PKCE verifier) for a token set. */
export function exchangeAgentCardCode(args: {
  code: string;
  codeVerifier: string;
  clientId: string;
}): Promise<AgentCardTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: agentCardRedirectUri(),
    client_id: args.clientId,
    code_verifier: args.codeVerifier,
  });
  return postToken(body);
}

/** Exchange a refresh token for a fresh access token. */
export function refreshAgentCardToken(args: {
  refreshToken: string;
  clientId: string;
}): Promise<AgentCardTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: args.refreshToken,
    client_id: args.clientId,
  });
  return postToken(body);
}

/** Best-effort token revocation (RFC 7009). Never throws. */
export async function revokeAgentCardToken(token: string): Promise<void> {
  try {
    await fetch(revocationEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    });
  } catch {
    // Revocation is best-effort; local disconnect succeeds regardless.
  }
}
