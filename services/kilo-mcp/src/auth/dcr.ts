/**
 * RFC 7591 dynamic client registration for public clients (requirement 16).
 *
 * This MCP only ever issues `code` + PKCE + refresh tokens to public clients:
 * `token_endpoint_auth_method` must be `none` (or omitted) and no client
 * secret is ever created. Redirect URIs are https, or http only on loopback
 * (RFC 8252 §7.3 native apps). Registration is capped in size and count so a
 * single worker cannot be filled with junk.
 *
 * The clientless registry is the input state of this endpoint: a registration
 * without any usable `redirect_uris` gets its own explicit error message.
 */
import { base64UrlEncode } from './pkce';
import { MCP_SCOPE, oauthErrorResponse, authJsonResponse, onlyMcpScope, scopeTokens } from './http';
import type { OAuthStoreApi } from '../store/oauth-store';

export type DcrDeps = {
  store: OAuthStoreApi;
  now?: () => Date;
};

/** Hard caps on one registration. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 255;

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

type RedirectUriCheck = { ok: true } | { ok: false; reason: string };

/** https anywhere; http only to loopback (localhost, 127.0.0.0/8, ::1). */
export function validateRedirectUri(value: unknown): RedirectUriCheck {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) {
    return { ok: false, reason: 'each redirect_uri must be a non-empty string' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `"${value}" is not an absolute URL` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'redirect_uri must not carry userinfo' };
  }
  if (url.hash) {
    return { ok: false, reason: 'redirect_uri must not carry a fragment' };
  }
  if (url.protocol === 'https:') return { ok: true };
  if (url.protocol === 'http:') {
    const host = url.hostname;
    // WHATWG URL keeps the brackets on an IPv6 hostname.
    const loopback =
      host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    if (!loopback) {
      return {
        ok: false,
        reason: 'plain http redirect_uri is only allowed on loopback (native apps)',
      };
    }
    return { ok: true };
  }
  return { ok: false, reason: 'redirect_uri scheme must be https or loopback http' };
}

type RegistrationBody = {
  redirectUris: string[];
  clientName: string;
  grantTypes: string[];
  responseTypes: string[];
  scope: string;
};

/** Parse + validate the client-supplied registration document. */
export function parseRegistration(
  body: unknown
): { ok: true; client: RegistrationBody } | { ok: false; error: string; description: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: 'Registration body must be a JSON object.',
    };
  }
  const record = body as Record<string, unknown>;

  const rawUris = record['redirect_uris'];
  if (rawUris === undefined) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description:
        'redirect_uris is required: a public client must register at least one redirect URI.',
    };
  }
  if (!Array.isArray(rawUris)) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: 'redirect_uris must be an array of URLs.',
    };
  }
  if (rawUris.length === 0 || rawUris.length > MAX_REDIRECT_URIS) {
    return {
      ok: false,
      error: 'invalid_redirect_uri',
      description: `redirect_uris must contain between 1 and ${MAX_REDIRECT_URIS} entries.`,
    };
  }
  for (const uri of rawUris) {
    const check = validateRedirectUri(uri);
    if (!check.ok) {
      return {
        ok: false,
        error: 'invalid_redirect_uri',
        description: `Invalid redirect_uri: ${check.reason}.`,
      };
    }
  }
  const redirectUris = [...new Set(rawUris as string[])];

  const authMethod = record['token_endpoint_auth_method'];
  if (authMethod !== undefined && authMethod !== 'none') {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description:
        "This authorization server only issues to public clients: token_endpoint_auth_method must be 'none'.",
    };
  }

  const grantTypes = record['grant_types'];
  if (grantTypes !== undefined) {
    if (
      !Array.isArray(grantTypes) ||
      grantTypes.length === 0 ||
      !grantTypes.every(g => typeof g === 'string' && ALLOWED_GRANT_TYPES.has(g))
    ) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        description: `grant_types must be a non-empty subset of ${[...ALLOWED_GRANT_TYPES].join(', ')}.`,
      };
    }
  }

  const responseTypes = record['response_types'];
  if (responseTypes !== undefined) {
    if (
      !Array.isArray(responseTypes) ||
      responseTypes.length === 0 ||
      !responseTypes.every(t => t === 'code')
    ) {
      return {
        ok: false,
        error: 'invalid_client_metadata',
        description:
          'response_types must be ["code"] — this server only issues authorization codes.',
      };
    }
  }

  const clientName = record['client_name'];
  if (
    clientName !== undefined &&
    (typeof clientName !== 'string' ||
      clientName.length === 0 ||
      clientName.length > MAX_CLIENT_NAME_LENGTH)
  ) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `client_name must be a string of 1..${MAX_CLIENT_NAME_LENGTH} characters.`,
    };
  }

  const scope = record['scope'];
  if (scope !== undefined && (typeof scope !== 'string' || !validScopeString(scope))) {
    return {
      ok: false,
      error: 'invalid_client_metadata',
      description: `scope must be a space-separated subset of "${MCP_SCOPE}".`,
    };
  }

  return {
    ok: true,
    client: {
      redirectUris,
      clientName: typeof clientName === 'string' ? clientName : 'Unnamed client',
      grantTypes: Array.isArray(grantTypes)
        ? (grantTypes as string[])
        : ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      scope: typeof scope === 'string' && scope.length > 0 ? scope : MCP_SCOPE,
    },
  };
}

function validScopeString(scope: string): boolean {
  // DCR rejects an empty scope; an omitted scope is defaulted by the caller.
  const tokens = scopeTokens(scope);
  return tokens.length > 0 && onlyMcpScope(tokens);
}

/** POST /register — RFC 7591. 201 with a client_id and no client_secret. */
export async function handleRegistration(request: Request, deps: DcrDeps): Promise<Response> {
  if (request.method !== 'POST') {
    return oauthErrorResponse(405, 'invalid_request', 'Use POST to register a client.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return oauthErrorResponse(
      400,
      'invalid_client_metadata',
      `Registration body exceeds ${MAX_BODY_BYTES} bytes.`
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return oauthErrorResponse(
      400,
      'invalid_client_metadata',
      'Registration body is not valid JSON.'
    );
  }

  const parsed = parseRegistration(body);
  if (!parsed.ok) {
    return oauthErrorResponse(400, parsed.error, parsed.description);
  }

  const now = deps.now?.() ?? new Date();
  const clientId = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const stored = await deps.store.registerClient({
    clientId,
    redirectUris: parsed.client.redirectUris,
    clientName: parsed.client.clientName,
    createdAt: now.toISOString(),
  });
  if (!stored) {
    // The registry is capped so unauthenticated DCR cannot fill it.
    return oauthErrorResponse(
      429,
      'temporarily_unavailable',
      'The client registry is at capacity. Retry later.'
    );
  }

  return authJsonResponse(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now.getTime() / 1000),
      client_name: parsed.client.clientName,
      redirect_uris: parsed.client.redirectUris,
      grant_types: parsed.client.grantTypes,
      response_types: parsed.client.responseTypes,
      token_endpoint_auth_method: 'none',
      scope: parsed.client.scope,
    },
    201
  );
}
