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

const consentCookieName = 'mcp_gateway_authorization_approval';

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

function formParams(form: FormData): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key === 'approval_state' || typeof value !== 'string') continue;
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
    return NextResponse.redirect(result.authorizationUrl);
  }
  return NextResponse.redirect(result.redirectUrl);
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

async function consentResponse(request: NextRequest, route?: ScopedConnectRoute) {
  const identity = await authorizationIdentity();
  if ('response' in identity) return identity.response;
  const parsed = OAuthAuthorizationQuerySchema.safeParse(
    stringParams(request.nextUrl.searchParams.entries())
  );
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const preview = await services.authorizationService.previewAuthorization({
    query: parsed.data,
    route,
    userId: identity.user.id,
    executionContext: identity.executionContext,
    redirectErrors: true,
  });
  const approvalState = randomToken(32);
  const approvalCookie = `${approvalState}.${approvalSignature({
    approvalState,
    clientId: preview.clientId,
    resource: preview.resource,
    scopes: preview.scopes,
    executionContext: identity.executionContext,
    secret: services.config.rateLimitSecret,
  })}`;
  const inputs = Object.entries(parsed.data)
    .map(
      ([key, value]) =>
        `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`
    )
    .join('');
  const response = new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><title>Authorize MCP Gateway</title></head><body><main><h1>Authorize MCP Gateway</h1><p>${escapeHtml(preview.clientName ?? preview.clientId)} wants access to ${escapeHtml(preview.resource)}.</p><p>Scopes: ${escapeHtml(preview.scopes.join(' ') || 'none')}</p><form method="post" action="${escapeHtml(request.nextUrl.pathname)}">${inputs}<input type="hidden" name="approval_state" value="${escapeHtml(approvalState)}"><button type="submit">Approve</button></form></main></body></html>`,
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
  const approvalState = form.get('approval_state');
  const raw = formParams(form);
  const parsed = OAuthAuthorizationQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }
  const services = createGatewayServices();
  const preview = await services.authorizationService.previewAuthorization({
    query: parsed.data,
    route,
    userId: identity.user.id,
    executionContext: identity.executionContext,
    redirectErrors: true,
  });
  const cookieState = request.cookies.get(consentCookieName)?.value;
  const [cookieApprovalState, cookieSignature] = cookieState?.split('.') ?? [];
  const expectedSignature = approvalSignature({
    approvalState: typeof approvalState === 'string' ? approvalState : '',
    clientId: preview.clientId,
    resource: preview.resource,
    scopes: preview.scopes,
    executionContext: identity.executionContext,
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
  const response = await authorizeRequest(
    parsed.data,
    route,
    identity.user.id,
    identity.executionContext
  );
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
