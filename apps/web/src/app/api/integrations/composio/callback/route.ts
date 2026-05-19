import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
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

export async function GET(request: NextRequest) {
  const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
  const parsedOrgId = organizationIdParam
    ? OrganizationIdSchema.safeParse(organizationIdParam)
    : null;
  const organizationId = parsedOrgId?.success ? parsedOrgId.data : undefined;
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'), organizationId);

  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL));
    }

    if (organizationIdParam) {
      if (!parsedOrgId?.success) {
        return NextResponse.redirect(new URL(appendError(returnTo, 'invalid_state'), APP_URL));
      }
      await ensureOrganizationAccess({ user }, parsedOrgId.data);
    }

    const providerStatus = request.nextUrl.searchParams.get('status');
    if (providerStatus === 'failed') {
      return NextResponse.redirect(new URL(appendResult(returnTo, 'failed'), APP_URL));
    }

    const connectedAccountId = request.nextUrl.searchParams.get('connected_account_id');
    if (providerStatus !== 'success' || !connectedAccountId) {
      return NextResponse.redirect(new URL(appendResult(returnTo, 'unknown'), APP_URL));
    }

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);
    if (!instance) {
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

    return NextResponse.redirect(
      new URL(appendResult(returnTo, verified ? 'success' : 'failed'), APP_URL)
    );
  } catch {
    return NextResponse.redirect(new URL(appendError(returnTo, 'unauthorized'), APP_URL));
  }
}
