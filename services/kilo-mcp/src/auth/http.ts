/**
 * Shared HTTP plumbing for the OAuth endpoints (metadata, DCR, authorize,
 * token): CORS, RFC 6749 §5.2 error bodies, HTML error/consent surfaces, and
 * the endpoint path constants every module routes against.
 */

/** The only scope this MCP issues; PKCE + DCR + resource indicator ride on it (requirement 16). */
export const MCP_SCOPE = 'mcp';

/** Routes served by the auth endpoints, shared by index.ts routing and metadata. */
export const AUTH_PATHS = {
  authorize: '/authorize',
  pairingStatus: '/authorize/status',
  orgPicker: '/authorize/org',
  token: '/token',
  register: '/register',
  mcp: '/mcp',
  authorizationServerMetadata: '/.well-known/oauth-authorization-server',
  authorizationServerMetadataScoped: '/.well-known/oauth-authorization-server/mcp',
  protectedResourceMetadata: '/.well-known/oauth-protected-resource',
  protectedResourceMetadataScoped: '/.well-known/oauth-protected-resource/mcp',
} as const;

/** How often the consent page re-checks pairing status (s5; rendered by s6's page). */
export const PAIRING_POLL_INTERVAL_MS = 2000;

const AUTH_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export function withAuthCors(response: Response): Response {
  for (const [key, value] of Object.entries(AUTH_CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export function authJsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {}
): Response {
  return withAuthCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
    })
  );
}

/** RFC 6749 §5.2 error object. `error_description` is operator-facing prose. */
export function oauthErrorResponse(
  status: number,
  error: string,
  errorDescription?: string
): Response {
  return authJsonResponse(
    { error, ...(errorDescription ? { error_description: errorDescription } : {}) },
    status,
    { 'Cache-Control': 'no-store' }
  );
}

export function htmlResponse(body: string, status = 200): Response {
  return withAuthCors(
    new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PAGE_STYLE =
  'body{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'background:#0b0d12;color:#e6e8ee;display:flex;justify-content:center;padding:48px 16px}' +
  '.card{max-width:480px;width:100%}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#aeb4c2}' +
  'code{background:#171a21;padding:2px 6px;border-radius:4px}' +
  'a.cta{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:8px;' +
  'background:#5b5bd6;color:#fff;text-decoration:none;font-weight:600}' +
  // an author display rule beats the UA [hidden] rule; keep hidden actually hidden.
  '[hidden]{display:none !important}';

/**
 * Minimal standalone page shell (the worker has no shared UI kit). `bodyHtml`
 * must already be escaped; only static markup is interpolated here.
 */
export function authPage(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body><div class="card">${bodyHtml}</div></body></html>`
  );
}

/** OAuth error rendered for the browser that opened /authorize. */
export function errorPage(error: string, description: string, status = 400): Response {
  return htmlResponse(
    authPage(
      'Authorization request failed',
      `<h1>Authorization request failed</h1><p>${escapeHtml(description)}</p>` +
        `<p>Reason: <code>${escapeHtml(error)}</code>. Close this tab and retry from your MCP client.</p>`
    ),
    status
  );
}

/** Redirect to the client with `error` params (RFC 6749 §4.1.2.1), only after client + redirect_uri validated. */
export function redirectToClientError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null
): Response {
  const url = new URL(redirectUri);
  url.searchParams.set('error', error);
  url.searchParams.set('error_description', description);
  if (state) url.searchParams.set('state', state);
  // `Response.redirect` yields immutable headers, which withAuthCors cannot
  // extend; a plain 302 with a Location header stays mutable.
  return withAuthCors(new Response(null, { status: 302, headers: { Location: url.toString() } }));
}
