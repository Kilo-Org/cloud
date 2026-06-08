import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { OAuthAuthorizationQuerySchema, type OAuthAuthorizationQuery } from '@kilocode/mcp-gateway';
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

const consentCookieName = 'mcp_gateway_authorization_approval';
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

export function redirectOAuthError(error: OAuthAuthorizationRedirectError) {
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set('error', error.code);
  redirect.searchParams.set('error_description', error.message);
  if (error.state) redirect.searchParams.set('state', error.state);
  return NextResponse.redirect(redirect.toString());
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
  executionContext: ReturnType<typeof executionContextFromAuth>
) {
  const services = createGatewayServices();
  const result = await services.authorizationService.authorize({
    query,
    route,
    userId,
    executionContext,
  });
  if (result.kind === 'provider_redirect') {
    return NextResponse.redirect(result.authorizationUrl, 303);
  }
  return NextResponse.redirect(result.redirectUrl, 303);
}

function approvalSignature(params: {
  approvalState: string;
  clientId: string;
  resource: string;
  scopes: string[];
  executionContext: ReturnType<typeof executionContextFromAuth>;
  secret: string;
}) {
  return hmacValue(JSON.stringify(params), params.secret);
}

function consentDocument(params: {
  action: string;
  approvalState: string;
  clientName: string;
  resource: string;
  scopes: string[];
  inputs: string;
}) {
  const scopes = params.scopes.length > 0 ? params.scopes : ['none'];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize Kilo Code</title>
    <style>
      :root {
        color-scheme: dark;
        --background: oklch(0.145 0 0);
        --surface: oklch(0.205 0 0);
        --surface-muted: oklch(0.269 0 0);
        --border: oklch(0.325 0 0);
        --foreground: oklch(0.985 0 0);
        --muted: oklch(0.708 0 0);
        --primary: oklch(0.95 0.15 108);
        --primary-foreground: oklch(0.145 0 0);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: var(--background);
        color: var(--foreground);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        width: min(100%, 34rem);
        margin: 0 auto;
        padding: 1.5rem;
      }
      .shell {
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 1.5rem;
      }
      .brand {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        color: var(--muted);
        font-size: 0.8125rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        margin-bottom: 1rem;
      }
      .brand-mark {
        width: 0.625rem;
        height: 0.625rem;
        border-radius: 999px;
        background: var(--primary);
      }
      .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 0.75rem;
        padding: 1.5rem;
        box-shadow: 0 10px 24px rgb(0 0 0 / 0.18);
      }
      h1 {
        margin: 0;
        font-size: 1.55rem;
        line-height: 1.2;
        letter-spacing: -0.025em;
        text-wrap: balance;
      }
      .lead {
        margin: 0.75rem 0 0;
        color: var(--muted);
        font-size: 0.95rem;
        line-height: 1.55;
        text-wrap: pretty;
      }
      .section {
        margin-top: 1.25rem;
      }
      .label {
        display: block;
        margin-bottom: 0.45rem;
        color: var(--muted);
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .resource {
        display: block;
        overflow-wrap: anywhere;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        background: var(--background);
        padding: 0.75rem;
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.78rem;
        line-height: 1.45;
      }
      .scopes {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }
      .scope {
        border: 1px solid var(--border);
        border-radius: 999px;
        background: var(--surface-muted);
        padding: 0.35rem 0.6rem;
        color: var(--foreground);
        font-size: 0.78rem;
        font-weight: 600;
      }
      form { margin-top: 1.5rem; }
      button {
        width: 100%;
        border: 0;
        border-radius: 0.5rem;
        background: var(--primary);
        color: var(--primary-foreground);
        padding: 0.72rem 0.95rem;
        font: inherit;
        font-size: 0.9rem;
        font-weight: 700;
        cursor: pointer;
        transition: transform 160ms ease, background 160ms ease;
      }
      button:hover { background: oklch(0.9 0.14 108); }
      button:focus-visible {
        outline: 2px solid var(--primary);
        outline-offset: 2px;
      }
      button:active { transform: translateY(1px); }
      .footer {
        margin: 1rem 0 0;
        color: var(--muted);
        font-size: 0.75rem;
        line-height: 1.45;
      }
      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <main>
        <div class="brand"><span class="brand-mark" aria-hidden="true"></span>Kilo Code</div>
        <section class="card" aria-labelledby="authorization-title">
          <h1 id="authorization-title">Authorize access</h1>
          <p class="lead">${escapeHtml(params.clientName)} wants access to this Kilo Code MCP connection.</p>
          <div class="section">
            <span class="label">Requested resource</span>
            <code class="resource">${escapeHtml(params.resource)}</code>
          </div>
          <div class="section">
            <span class="label">Scopes</span>
            <div class="scopes">${scopes
              .map(scope => `<span class="scope">${escapeHtml(scope)}</span>`)
              .join('')}</div>
          </div>
          <form method="post" action="${escapeHtml(params.action)}">
            ${params.inputs}
            <input type="hidden" name="approval_state" value="${escapeHtml(params.approvalState)}">
            <button type="submit">Approve access</button>
          </form>
        </section>
        <p class="footer">You can revoke this access later from Kilo Code.</p>
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
    redirectErrors: true,
  });
  const approvalState = randomToken(32);
  const approvalCookie = `${approvalState}.${approvalSignature({
    approvalState,
    clientId: preview.clientId,
    resource: preview.resource,
    scopes: preview.scopes,
    executionContext,
    secret: services.config.rateLimitSecret,
  })}`;
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
      clientName: preview.clientName ?? preview.clientId,
      resource: preview.resource,
      scopes: preview.scopes,
      inputs,
    }),
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
  response.cookies.set(consentCookieName, approvalCookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: request.nextUrl.pathname,
    maxAge: 300,
  });
  return response;
}

async function approveRequest(request: NextRequest, route?: ScopedConnectRoute) {
  const identity = await authorizationIdentity();
  if ('response' in identity) return identity.response;
  const form = await request.formData();
  if (hasDuplicateSingletonParams(form, [...authorizationSingletonParams, 'approval_state'])) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const approvalState = form.get('approval_state');
  const raw = stringFormParams(form, authorizationSingletonParams, ['approval_state']);
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
    redirectErrors: true,
  });
  const cookieState = request.cookies.get(consentCookieName)?.value;
  const [cookieApprovalState, cookieSignature] = cookieState?.split('.') ?? [];
  const expectedSignature = approvalSignature({
    approvalState: typeof approvalState === 'string' ? approvalState : '',
    clientId: preview.clientId,
    resource: preview.resource,
    scopes: preview.scopes,
    executionContext,
    secret: services.config.rateLimitSecret,
  });
  if (
    typeof approvalState !== 'string' ||
    !cookieApprovalState ||
    !cookieSignature ||
    !timingSafeEqual(approvalState, cookieApprovalState) ||
    !timingSafeEqual(expectedSignature, cookieSignature)
  ) {
    return redirectOAuthError(
      new OAuthAuthorizationRedirectError(
        'access_denied',
        'Authorization approval was not confirmed',
        parsed.data.redirect_uri,
        parsed.data.state
      )
    );
  }
  const response = await authorizeRequest(parsed.data, route, identity.user.id, executionContext);
  response.cookies.delete(consentCookieName);
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
      return redirectOAuthError(error);
    }
    return gatewayErrorResponse(error);
  }
}

export { consentResponse, approveRequest };
