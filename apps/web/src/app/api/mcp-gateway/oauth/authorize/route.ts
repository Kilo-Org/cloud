import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import {
  GatewayMcpAccessScope,
  OAuthAuthorizationQuerySchema,
  type OAuthAuthorizationQuery,
} from '@kilocode/mcp-gateway';
import { timingSafeEqual } from '@kilocode/encryption';
import { getUserFromAuth } from '@/lib/user/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import type { ScopedConnectRoute } from '@kilocode/mcp-gateway';
import { executionContextFromAuth } from '@/lib/mcp-gateway/context';
import { hmacValue, randomToken } from '@/lib/mcp-gateway/crypto';
import { OAuthAuthorizationRedirectError } from '@/lib/mcp-gateway/authorization-service';
import {
  hasDuplicateSingletonParams,
  stringFormParams,
} from '@/lib/mcp-gateway/oauth-request-params';

const consentCookiePrefix = 'mcp_gateway_authorization_approval_';
const consentLifetimeSeconds = 300;
const authorizationSingletonParams = [
  'client_id',
  'redirect_uri',
  'response_type',
  'scope',
  'state',
  'resource',
  'code_challenge',
  'code_challenge_method',
] as const;
const consentDecisionValues = ['allow', 'deny'] as const;
type ConsentDecision = (typeof consentDecisionValues)[number];

function consentSecurityHeaders(redirectUri: string) {
  const callback = new URL(redirectUri);
  const callbackSource = callback.protocol === 'http:' ? ` ${callback.origin}` : '';
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https:${callbackSource}; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  } as const;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stringParams(entries: IterableIterator<[string, string]>): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of entries) {
    params[key] = value;
  }
  return params;
}

export function redirectOAuthError(error: OAuthAuthorizationRedirectError, status = 307) {
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.message);
  if (error.state) redirect.searchParams.set('state', error.state);
  const response = NextResponse.redirect(redirect.toString(), status);
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

async function authorizationIdentity() {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return { response: authFailedResponse };
  if (!user) return { response: NextResponse.json({ error: 'access_denied' }, { status: 401 }) };
  return { user, executionContext: executionContextFromAuth(organizationId) };
}

async function authorizeRequest(
  query: OAuthAuthorizationQuery,
  route: ScopedConnectRoute | undefined,
  userId: string,
  executionContext: ReturnType<typeof executionContextFromAuth>,
  allowBrowserOrgResourceContext: boolean
) {
  const services = createGatewayServices();
  const result = await services.authorizationService.authorize({
    query,
    route,
    userId,
    executionContext,
    allowBrowserOrgResourceContext,
  });
  const response = NextResponse.redirect(
    result.kind === 'provider_redirect' ? result.authorizationUrl : result.redirectUrl,
    303
  );
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function approvalSignature(params: {
  approvalState: string;
  userId: string;
  clientId: string;
  redirectUri: string;
  responseType: string;
  resource: string;
  scopes: string[];
  oauthState: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  executionContext: ReturnType<typeof executionContextFromAuth>;
  secret: string;
}) {
  const { secret, ...payload } = params;
  return hmacValue(JSON.stringify(payload), secret);
}

function parseConsentDecision(value: FormDataEntryValue | null): ConsentDecision | null {
  return value === 'allow' || value === 'deny' ? value : null;
}

function createApprovalState() {
  return `${Math.floor(Date.now() / 1000)}.${randomToken(32)}`;
}

function approvalStateIsFresh(approvalState: string) {
  if (!/^\d{10,}\.[A-Za-z0-9_-]{43}$/.test(approvalState)) return false;
  const [issuedAt] = approvalState.split('.');
  const issuedAtSeconds = Number(issuedAt);
  const nowSeconds = Math.floor(Date.now() / 1000);
  return (
    Number.isSafeInteger(issuedAtSeconds) &&
    issuedAtSeconds <= nowSeconds &&
    nowSeconds - issuedAtSeconds <= consentLifetimeSeconds
  );
}

function consentCookieName(approvalState: string) {
  return `${consentCookiePrefix}${approvalState}`;
}

function clearConsentCookie(response: NextResponse, request: NextRequest, approvalState: string) {
  response.cookies.set(consentCookieName(approvalState), '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: request.nextUrl.pathname,
    maxAge: 0,
  });
}

function consentScopeLabel(scope: string) {
  if (scope === GatewayMcpAccessScope) return 'Use this MCP connection';
  if (scope === 'profile') return 'View your Kilo profile';
  return scope;
}

function consentDocument(params: {
  action: string;
  approvalState: string;
  clientId: string;
  redirectUri: string;
  connectionName: string;
  endpointHost: string;
  contextName: string;
  ownerScope: 'personal' | 'organization';
  userName: string;
  userEmail: string;
  scopes: string[];
  inputs: string;
}) {
  const callback = new URL(params.redirectUri);
  const callbackIsLoopback = ['127.0.0.1', '[::1]', 'localhost'].includes(callback.hostname);
  const scopes =
    params.scopes.length > 0
      ? params.scopes
          .map(scope => `<span class="scope">${escapeHtml(consentScopeLabel(scope))}</span>`)
          .join('')
      : '<span class="scope muted-scope">No permissions requested</span>';
  const contextLabel = params.ownerScope === 'organization' ? 'Organization' : 'Context';
  const callbackExplanation = callbackIsLoopback
    ? 'Kilo will return the authorization result to an app running on this device.'
    : 'Kilo will send the authorization result to this external destination.';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Allow MCP access | Kilo Code</title>
    <style>
      :root {
        color-scheme: dark;
        --background: oklch(0.145 0 0);
        --surface: oklch(0.205 0 0);
        --surface-muted: oklch(0.269 0 0);
        --border: oklch(1 0 0 / 12%);
        --foreground: oklch(0.985 0 0);
        --muted: oklch(0.708 0 0);
        --primary: oklch(0.95 0.15 108);
        --primary-hover: oklch(0.9 0.14 108);
        --primary-foreground: oklch(0.145 0 0);
        --warning: oklch(0.78 0.14 75);
        --warning-surface: oklch(0.3 0.04 75);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--background);
        color: var(--foreground);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1.5rem;
      }
      main { width: min(100%, 38rem); }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1rem;
        color: var(--muted);
        font-size: 0.8125rem;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .brand-mark {
        width: 0.625rem;
        height: 0.625rem;
        border-radius: 999px;
        background: var(--primary);
      }
      .card {
        overflow: hidden;
        border: 1px solid var(--border);
        border-radius: 0.875rem;
        background: var(--surface);
        box-shadow: 0 16px 40px rgb(0 0 0 / 0.22);
      }
      .header, .content, .actions { padding: 1.5rem; }
      .header { border-bottom: 1px solid var(--border); }
      .eyebrow {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        margin-bottom: 0.7rem;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        border: 1px solid color-mix(in oklch, var(--warning), transparent 45%);
        border-radius: 999px;
        background: var(--warning-surface);
        padding: 0.25rem 0.55rem;
        color: var(--warning);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        font-size: 1.55rem;
        line-height: 1.2;
        letter-spacing: -0.025em;
        text-wrap: balance;
      }
      .lead, .supporting {
        margin: 0.65rem 0 0;
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.55;
        text-wrap: pretty;
      }
      .client-id { color: var(--muted); font-size: 0.76rem; }
      .warning {
        margin-bottom: 1.25rem;
        border: 1px solid color-mix(in oklch, var(--warning), transparent 60%);
        border-radius: 0.625rem;
        background: color-mix(in oklch, var(--warning-surface), transparent 15%);
        padding: 0.9rem;
      }
      .warning strong { display: block; color: var(--foreground); font-size: 0.9rem; }
      .warning p { margin: 0.35rem 0 0; color: var(--muted); font-size: 0.82rem; line-height: 1.5; }
      dl { margin: 0; }
      .detail {
        display: grid;
        grid-template-columns: 8.25rem minmax(0, 1fr);
        gap: 1rem;
        padding: 0.85rem 0;
        border-top: 1px solid var(--border);
      }
      .detail:first-child { border-top: 0; padding-top: 0; }
      dt {
        color: var(--muted);
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      dd { min-width: 0; margin: 0; font-size: 0.87rem; line-height: 1.45; }
      .value-primary { display: block; color: var(--foreground); font-weight: 600; }
      .value-secondary { display: block; margin-top: 0.15rem; color: var(--muted); font-size: 0.78rem; }
      code {
        display: block;
        margin-top: 0.4rem;
        overflow-wrap: anywhere;
        color: var(--foreground);
        font-family: "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.75rem;
        line-height: 1.5;
      }
      .scopes { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.45rem; }
      .scope {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface-muted);
        padding: 0.28rem 0.52rem;
        color: var(--foreground);
        font-size: 0.72rem;
        font-weight: 600;
      }
      .muted-scope { color: var(--muted); }
      .actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
        border-top: 1px solid var(--border);
        background: color-mix(in oklch, var(--surface), var(--background) 18%);
      }
      button {
        min-height: 2.75rem;
        border-radius: 0.5rem;
        padding: 0.72rem 0.95rem;
        font: inherit;
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        transition: transform 160ms ease, background 160ms ease, border-color 160ms ease;
      }
      button:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
      button:active { transform: translateY(1px); }
      .deny {
        border: 1px solid var(--border);
        background: transparent;
        color: var(--foreground);
      }
      .deny:hover { border-color: color-mix(in oklch, var(--foreground), transparent 55%); background: var(--surface-muted); }
      .allow { border: 1px solid var(--primary); background: var(--primary); color: var(--primary-foreground); }
      .allow:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
      @media (max-width: 34rem) {
        .shell { padding: 0; place-items: start center; }
        main { width: 100%; }
        .brand { margin: 1.25rem 1.25rem 0.9rem; }
        .card { border-right: 0; border-left: 0; border-radius: 0; }
        .detail { grid-template-columns: 1fr; gap: 0.3rem; }
        .actions { grid-template-columns: 1fr; }
      }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    </style>
  </head>
  <body>
    <div class="shell">
      <main>
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span>Kilo Code</div>
        <section class="card" aria-labelledby="authorization-title">
          <header class="header">
            <div class="eyebrow"><span class="badge">Unverified app</span></div>
            <h1 id="authorization-title">Allow access to this MCP connection?</h1>
            <p class="lead">An app is requesting access. Kilo has not verified who operates it.</p>
            <code class="client-id">${escapeHtml(params.clientId)}</code>
          </header>
          <div class="content">
            <div class="warning">
              <strong>This grants broad MCP access</strong>
              <p>The app will be able to use all tools and data exposed by this MCP connection. Requests may use credentials configured for the connection and may read, create, modify, or delete data on connected services.</p>
            </div>
            <dl>
              <div class="detail">
                <dt>MCP connection</dt>
                <dd><span class="value-primary">${escapeHtml(params.connectionName)}</span><span class="value-secondary">Endpoint: ${escapeHtml(params.endpointHost)}</span></dd>
              </div>
              <div class="detail">
                <dt>${contextLabel}</dt>
                <dd><span class="value-primary">${escapeHtml(params.contextName)}</span></dd>
              </div>
              <div class="detail">
                <dt>Granting access as</dt>
                <dd><span class="value-primary">${escapeHtml(params.userName)}</span><span class="value-secondary">${escapeHtml(params.userEmail)}</span></dd>
              </div>
              <div class="detail">
                <dt>Callback destination</dt>
                <dd><span class="value-primary">${escapeHtml(callback.host)}</span><span class="value-secondary">${callbackExplanation}</span><code>${escapeHtml(params.redirectUri)}</code></dd>
              </div>
              <div class="detail">
                <dt>Permissions</dt>
                <dd><div class="scopes">${scopes}</div></dd>
              </div>
            </dl>
          </div>
          <form method="post" action="${escapeHtml(params.action)}">
            ${params.inputs}
            <input type="hidden" name="approval_state" value="${escapeHtml(params.approvalState)}">
            <div class="actions">
              <button class="deny" type="submit" name="decision" value="deny">Deny access</button>
              <button class="allow" type="submit" name="decision" value="allow">Allow access</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  </body>
</html>`;
}

async function consentResponse(request: NextRequest, route?: ScopedConnectRoute) {
  const identity = await authorizationIdentity();
  if ('response' in identity) return identity.response;
  if (hasDuplicateSingletonParams(request.nextUrl.searchParams, authorizationSingletonParams)) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const parsed = OAuthAuthorizationQuerySchema.safeParse(
    stringParams(request.nextUrl.searchParams.entries())
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const executionContext = identity.executionContext;
  const preview = await services.authorizationService.previewAuthorization({
    query: parsed.data,
    route,
    userId: identity.user.id,
    executionContext,
    allowBrowserOrgResourceContext: !request.headers.has('Authorization'),
    redirectErrors: true,
  });
  const resolvedExecutionContext = preview.executionContext;
  const approvalState = createApprovalState();
  const approvalCookie = approvalSignature({
    approvalState,
    userId: identity.user.id,
    clientId: preview.clientId,
    redirectUri: preview.redirectUri,
    responseType: parsed.data.response_type,
    resource: preview.resource,
    scopes: preview.scopes,
    oauthState: parsed.data.state ?? null,
    codeChallenge: parsed.data.code_challenge ?? null,
    codeChallengeMethod: parsed.data.code_challenge_method ?? null,
    executionContext: resolvedExecutionContext,
    secret: services.config.rateLimitSecret,
  });
  const inputs = Object.entries(parsed.data)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`
    )
    .join('');
  const response = new NextResponse(
    consentDocument({
      action: request.nextUrl.pathname,
      approvalState,
      clientId: preview.clientId,
      redirectUri: preview.redirectUri,
      connectionName: preview.connectionName,
      endpointHost: preview.endpointHost,
      contextName: preview.contextName,
      ownerScope: preview.ownerScope,
      userName: identity.user.google_user_name || identity.user.google_user_email,
      userEmail: identity.user.google_user_email,
      scopes: preview.scopes,
      inputs,
    }),
    {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...consentSecurityHeaders(preview.redirectUri),
      },
    }
  );
  response.cookies.set(consentCookieName(approvalState), approvalCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: request.nextUrl.pathname,
    maxAge: consentLifetimeSeconds,
  });
  return response;
}

async function approveRequest(request: NextRequest, route?: ScopedConnectRoute) {
  const identity = await authorizationIdentity();
  if ('response' in identity) return identity.response;
  const form = await request.formData();
  if (
    hasDuplicateSingletonParams(form, [
      ...authorizationSingletonParams,
      'approval_state',
      'decision',
    ])
  ) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const approvalState = form.get('approval_state');
  const decision = parseConsentDecision(form.get('decision'));
  if (!decision) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const raw = stringFormParams(form, authorizationSingletonParams, ['approval_state', 'decision']);
  const parsed = OAuthAuthorizationQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const executionContext = identity.executionContext;
  const preview = await services.authorizationService.previewAuthorization({
    query: parsed.data,
    route,
    userId: identity.user.id,
    executionContext,
    allowBrowserOrgResourceContext: !request.headers.has('Authorization'),
    redirectErrors: true,
  });
  const resolvedExecutionContext = preview.executionContext;
  const approvalStateValue = typeof approvalState === 'string' ? approvalState : '';
  const approvalStateValid =
    approvalStateValue.length > 0 && approvalStateIsFresh(approvalStateValue);
  const cookieSignature = approvalStateValid
    ? request.cookies.get(consentCookieName(approvalStateValue))?.value
    : undefined;
  const expectedSignature = approvalSignature({
    approvalState: approvalStateValue,
    userId: identity.user.id,
    clientId: preview.clientId,
    redirectUri: preview.redirectUri,
    responseType: parsed.data.response_type,
    resource: preview.resource,
    scopes: preview.scopes,
    oauthState: parsed.data.state ?? null,
    codeChallenge: parsed.data.code_challenge ?? null,
    codeChallengeMethod: parsed.data.code_challenge_method ?? null,
    executionContext: resolvedExecutionContext,
    secret: services.config.rateLimitSecret,
  });
  if (
    !approvalStateValid ||
    !cookieSignature ||
    !timingSafeEqual(expectedSignature, cookieSignature)
  ) {
    const response = redirectOAuthError(
      new OAuthAuthorizationRedirectError(
        'access_denied',
        'Authorization approval was not confirmed',
        parsed.data.redirect_uri,
        parsed.data.state
      ),
      303
    );
    if (approvalStateValid) {
      clearConsentCookie(response, request, approvalStateValue);
    }
    return response;
  }
  if (decision === 'deny') {
    await services.auditService.record({
      actorUserId: identity.user.id,
      ownerScope: preview.ownerScope,
      ownerId: preview.ownerId,
      configId: preview.configId,
      connectResourceId: preview.connectResourceId,
      instanceId: null,
      oauthGrantId: null,
      eventType: 'authorization_denied',
      outcome: 'blocked',
    });
    const response = redirectOAuthError(
      new OAuthAuthorizationRedirectError(
        'access_denied',
        'The user denied the authorization request',
        preview.redirectUri,
        parsed.data.state
      ),
      303
    );
    clearConsentCookie(response, request, approvalStateValue);
    return response;
  }
  const response = await authorizeRequest(
    parsed.data,
    route,
    identity.user.id,
    resolvedExecutionContext,
    !request.headers.has('Authorization')
  );
  clearConsentCookie(response, request, approvalStateValue);
  return response;
}

export async function GET(request: NextRequest) {
  try {
    return await consentResponse(request);
  } catch (error) {
    if (error instanceof OAuthAuthorizationRedirectError) {
      return redirectOAuthError(error);
    }
    return gatewayErrorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    return await approveRequest(request);
  } catch (error) {
    if (error instanceof OAuthAuthorizationRedirectError) {
      return redirectOAuthError(error, 303);
    }
    return gatewayErrorResponse(error);
  }
}

export { consentResponse, approveRequest };
