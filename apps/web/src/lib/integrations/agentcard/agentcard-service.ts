import 'server-only';

import crypto from 'node:crypto';
import { APP_URL } from '@/lib/constants';
import {
  AGENTCARD_MCP_BASE_URL,
  AGENTCARD_OAUTH_CLIENT_ID,
  AGENTCARD_OAUTH_CLIENT_SECRET,
} from '@/lib/config.server';

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
 * Client types (PKCE is enforced for both):
 * - Dynamically registered clients (no pinned AGENTCARD_OAUTH_CLIENT_ID) are
 *   *public* (token_endpoint_auth_method = "none") — no client secret.
 * - A pinned client minted by AgentCard's admin CLI is *confidential by
 *   default*: set AGENTCARD_OAUTH_CLIENT_SECRET and it is sent on token
 *   exchange, refresh, and revocation. A pinned client created with `--public`
 *   is PKCE-only; leave the secret unset.
 *
 * Every /authorize and /token request carries the RFC 8707 `resource`
 * indicator (the MCP server URL) so issued tokens are audience-bound.
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

/**
 * The RFC 8707 resource indicator: tokens are requested for (and bound to)
 * AgentCard's MCP server. Sent on /authorize and every /token grant.
 */
export function agentCardResource(): string {
  return `${AGENTCARD_MCP_BASE_URL}/mcp`;
}

/**
 * Returns the client secret for a given client_id, or null for public clients.
 *
 * Only the pinned AGENTCARD_OAUTH_CLIENT_ID can be confidential — dynamically
 * registered clients are always public, so a configured secret must never be
 * sent for them (the token endpoint would reject the mismatch).
 */
export function agentCardClientSecretFor(clientId: string): string | null {
  if (
    AGENTCARD_OAUTH_CLIENT_ID &&
    AGENTCARD_OAUTH_CLIENT_SECRET &&
    clientId === AGENTCARD_OAUTH_CLIENT_ID
  ) {
    return AGENTCARD_OAUTH_CLIENT_SECRET;
  }
  return null;
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
  url.searchParams.set('resource', agentCardResource());
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

/**
 * Exchange an authorization code (+ PKCE verifier) for a token set. The
 * confidential-client secret (when the pinned client has one) is REQUIRED here
 * — PKCE is enforced either way, the secret is additive.
 */
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
    resource: agentCardResource(),
  });
  const clientSecret = agentCardClientSecretFor(args.clientId);
  if (clientSecret) {
    body.set('client_secret', clientSecret);
  }
  return postToken(body);
}

// NOTE: there is intentionally no refresh helper here. Refresh happens inside
// the worker via mcporter's native MCP OAuth (refresh-on-401 with the rotating
// refresh token); the web app never refreshes. AgentCard requires the
// client_secret on the refresh grant too for confidential clients, which is
// why config-writer seeds it into mcporter's client.json.

/** Best-effort token revocation (RFC 7009). Never throws. */
export async function revokeAgentCardToken(args: {
  token: string;
  clientId: string;
}): Promise<void> {
  try {
    const body = new URLSearchParams({ token: args.token, client_id: args.clientId });
    const clientSecret = agentCardClientSecretFor(args.clientId);
    if (clientSecret) {
      body.set('client_secret', clientSecret);
    }
    await fetch(revocationEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch {
    // Revocation is best-effort; local disconnect succeeds regardless.
  }
}
