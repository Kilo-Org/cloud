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

// Kilo Cloud palette, copied from apps/web/src/app/globals.css: near-black
// canvas, raised charcoal card, brand-primary CTA. Dark-only, like the product.
const PAGE_STYLE =
  ':root{color-scheme:dark;--background:#151515;--card:#202020;--overlay:#333333;' +
  '--hover:#3a3a3a;--foreground:#fafafa;--muted:#a3a3a3;--primary:#f7f586;' +
  '--primary-hover:#e6e475;--primary-foreground:#1f1f1f;--border:#ffffff1a;' +
  '--border-strong:#ffffff2e;--input:#ffffff0a;--ring:#f7f58659;--danger:#ef4444}' +
  '*{box-sizing:border-box}' +
  'body{margin:0;background:var(--background);color:var(--foreground);' +
  'font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;' +
  'font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;' +
  'display:flex;justify-content:center;align-items:flex-start;min-height:100vh;padding:48px 16px}' +
  '.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);' +
  'border-radius:12px;padding:28px}' +
  '.brand{display:flex;align-items:center;gap:8px;margin-bottom:20px;color:var(--muted);' +
  'font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}' +
  '.brand-dot{width:8px;height:8px;border-radius:2px;background:var(--primary)}' +
  'h1{font-size:18px;line-height:1.3;margin:0 0 8px;font-weight:600;letter-spacing:-.01em}' +
  'p{margin:0 0 12px;color:var(--muted);line-height:1.55}' +
  'strong{color:var(--foreground);font-weight:600}' +
  'code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;' +
  'background:var(--input);border:1px solid var(--border);padding:2px 6px;border-radius:6px;' +
  'color:var(--foreground)}' +
  'a.cta,button.cta{display:flex;align-items:center;justify-content:center;width:100%;' +
  'margin-top:20px;padding:11px 16px;border-radius:8px;background:var(--primary);' +
  'color:var(--primary-foreground);text-decoration:none;font-weight:600;font-size:14px;' +
  'border:0;cursor:pointer}' +
  'a.cta:hover,button.cta:hover{background:var(--primary-hover)}' +
  'a.cta:focus-visible,button.cta:focus-visible{outline:2px solid var(--ring);outline-offset:2px}' +
  'a.secondary{display:inline-block;margin-top:14px;color:var(--muted);text-decoration:none;' +
  'font-size:13px}' +
  'a.secondary:hover{color:var(--foreground)}' +
  '#status{margin:16px 0 0;color:var(--muted);font-size:13px}' +
  // an author display rule beats the UA [hidden] rule; keep hidden actually hidden.
  '[hidden]{display:none !important}';

/**
 * Minimal standalone page shell (the worker has no shared UI kit). `bodyHtml`
 * must already be escaped; only static markup is interpolated here. The brand
 * row and palette mirror the Kilo Cloud web app so connecting an MCP client
 * reads as a Kilo surface, not a generic OAuth page.
 */
export function authPage(title: string, bodyHtml: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>` +
    `<body><div class="card"><div class="brand"><span class="brand-dot"></span>Kilo</div>` +
    `${bodyHtml}</div></body></html>`
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
