import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { isSafeGoogleOAuthReturnTo } from '@/lib/integrations/google/oauth-state';
import { completeManagedComposioGoogleCalendarConnection } from '@/lib/kiloclaw/composio-onboarding';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

const OrganizationIdSchema = z.string().uuid();

function safeReturnTo(value: string | null, organizationId?: string): string {
  if (value && value.length <= 500 && isSafeGoogleOAuthReturnTo(value)) return value;
  if (organizationId) return `/organizations/${organizationId}/claw/new?step=tools`;
  return '/claw/new?step=tools';
}

function appendResult(path: string, result: 'success' | 'failed' | 'unknown'): string {
  const parsedPath = new URL(path, APP_URL);
  const next = parsedPath.searchParams;
  next.set('step', 'tools');

  if (result === 'success') {
    next.set('success', 'composio_connected');
    next.delete('error');
  } else if (result === 'failed') {
    next.set('error', 'connection_failed');
    next.delete('success');
  } else {
    next.delete('success');
    next.delete('error');
  }

  return `${parsedPath.pathname}?${next.toString()}`;
}

function appendError(path: string, error: string): string {
  const parsedPath = new URL(path, APP_URL);
  const next = parsedPath.searchParams;
  next.set('step', 'tools');
  next.set('error', error);
  next.delete('success');
  return `${parsedPath.pathname}?${next.toString()}`;
}

function callbackFailureError(error: unknown): 'unauthorized' | 'internal_error' {
  return error instanceof TRPCError && error.code === 'UNAUTHORIZED'
    ? 'unauthorized'
    : 'internal_error';
}

function serializeInlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function popupResultResponse(
  result: 'success' | 'failed' | 'unknown',
  error?: string,
  attemptId?: string | null
): NextResponse {
  const title = result === 'success' ? 'Google Calendar connected' : 'Connection incomplete';
  const description =
    result === 'success'
      ? 'Close this popup and return to KiloClaw onboarding to continue.'
      : 'Close this popup and return to KiloClaw onboarding to try again or skip for now.';
  const payload = serializeInlineJson({
    type: 'kiloclaw:composio-connect',
    result,
    attemptId: attemptId ?? null,
    ...(error ? { error } : {}),
  });
  const targetOrigin = serializeInlineJson(new URL(APP_URL).origin);
  return new NextResponse(
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: oklch(0.145 0 0);
        color: oklch(0.985 0 0);
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }
      main {
        width: min(360px, calc(100vw - 48px));
        border: 1px solid oklch(1 0 0 / 0.1);
        border-radius: 14px;
        background: oklch(0.205 0 0);
        padding: 24px;
      }
      .eyebrow {
        color: oklch(0.95 0.15 108);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      h1 { margin: 10px 0 8px; font-size: 20px; line-height: 1.25; }
      p { margin: 0; color: oklch(0.708 0 0); font-size: 14px; line-height: 1.5; }
      button {
        margin-top: 18px;
        border: 0;
        border-radius: 8px;
        background: oklch(0.95 0.15 108);
        color: oklch(0.205 0 0);
        cursor: pointer;
        font: inherit;
        font-size: 14px;
        font-weight: 600;
        padding: 10px 14px;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow">KiloClaw</div>
      <h1>${title}</h1>
      <p>${description}</p>
      <button type="button" onclick="window.close()">Close popup</button>
    </main>
    <script>
      try {
        localStorage.setItem('kiloclaw:composio-connect-result', JSON.stringify({ ...${payload}, at: Date.now() }));
      } catch {}
      try {
        const channel = new BroadcastChannel('kiloclaw:composio-connect');
        channel.postMessage(${payload});
        channel.close();
      } catch {}
      if (window.opener) {
        window.opener.postMessage(${payload}, ${targetOrigin});
        window.close();
      }
    </script>
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

export async function GET(request: NextRequest) {
  const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
  const parsedOrgId = organizationIdParam
    ? OrganizationIdSchema.safeParse(organizationIdParam)
    : null;
  const organizationId = parsedOrgId?.success ? parsedOrgId.data : undefined;
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'), organizationId);
  const popup = request.nextUrl.searchParams.get('popup') === '1';
  const attemptId = request.nextUrl.searchParams.get('attemptId');

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      if (popup) return popupResultResponse('failed', 'unauthorized', attemptId);
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    if (organizationIdParam) {
      if (!parsedOrgId?.success) {
        if (popup) return popupResultResponse('failed', 'invalid_state', attemptId);
        return NextResponse.redirect(new URL(appendError(returnTo, 'invalid_state'), APP_URL));
      }
      await ensureOrganizationAccess({ user }, parsedOrgId.data);
    }

    const providerStatus = request.nextUrl.searchParams.get('status');
    if (providerStatus === 'failed') {
      if (popup) return popupResultResponse('failed', 'connection_failed', attemptId);
      return NextResponse.redirect(new URL(appendResult(returnTo, 'failed'), APP_URL));
    }

    const connectedAccountId = request.nextUrl.searchParams.get('connected_account_id');
    if (providerStatus !== 'success' || !connectedAccountId) {
      if (popup) return popupResultResponse('unknown', undefined, attemptId);
      return NextResponse.redirect(new URL(appendResult(returnTo, 'unknown'), APP_URL));
    }

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);
    if (!instance) {
      if (popup) return popupResultResponse('failed', 'missing_instance', attemptId);
      return NextResponse.redirect(new URL(appendError(returnTo, 'missing_instance'), APP_URL));
    }

    const verified = await completeManagedComposioGoogleCalendarConnection({
      userId: user.id,
      instance,
      scope: organizationId
        ? { ownerType: 'organization_user', userId: user.id, organizationId }
        : { ownerType: 'user', userId: user.id },
      connectedAccountId,
    });

    if (popup) return popupResultResponse(verified ? 'success' : 'failed', undefined, attemptId);
    return NextResponse.redirect(
      new URL(appendResult(returnTo, verified ? 'success' : 'failed'), APP_URL)
    );
  } catch (error) {
    const failureError = callbackFailureError(error);
    if (popup) return popupResultResponse('failed', failureError, attemptId);
    return NextResponse.redirect(new URL(appendError(returnTo, failureError), APP_URL));
  }
}
