import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL } from '@/lib/constants';
import { getUserFromAuth } from '@/lib/user.server';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { getActiveInstance, getActiveOrgInstance } from '@/lib/kiloclaw/instance-registry';
import {
  clearKiloClawGoogleOAuthConnection,
  getKiloClawGoogleOAuthConnection,
} from '@/lib/kiloclaw/google-oauth-connections';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';

const OrganizationIdSchema = z.string().uuid();

function buildDisconnectPath(organizationId: string | undefined, queryParam: string): string {
  if (organizationId) {
    return `/organizations/${organizationId}/claw/settings?${queryParam}`;
  }

  return `/claw/settings?${queryParam}`;
}

function isSameOriginMutation(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;

  try {
    return new URL(origin).origin === new URL(APP_URL).origin;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  let organizationId: string | undefined;

  try {
    if (!isSameOriginMutation(request)) {
      return NextResponse.redirect(new URL('/claw/settings?error=invalid_origin', APP_URL), 303);
    }

    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) {
      return NextResponse.redirect(new URL('/users/sign_in', APP_URL), 303);
    }

    const organizationIdParam = request.nextUrl.searchParams.get('organizationId');
    if (organizationIdParam) {
      const parsedOrgId = OrganizationIdSchema.safeParse(organizationIdParam);
      if (!parsedOrgId.success) {
        return NextResponse.redirect(
          new URL('/claw/settings?error=invalid_organization', APP_URL),
          303
        );
      }
      organizationId = parsedOrgId.data;
      await ensureOrganizationAccess({ user }, organizationId);
    }

    const instance = organizationId
      ? await getActiveOrgInstance(user.id, organizationId)
      : await getActiveInstance(user.id);

    if (!instance) {
      captureMessage('Google disconnect missing active KiloClaw instance', {
        level: 'warning',
        tags: { endpoint: 'google/disconnect', source: 'google_oauth' },
        extra: {
          userId: user.id,
          organizationId,
        },
      });

      return NextResponse.redirect(
        new URL(buildDisconnectPath(organizationId, 'error=missing_instance'), APP_URL),
        303
      );
    }

    const existingConnection = await getKiloClawGoogleOAuthConnection(instance.id);
    if (existingConnection) {
      console.log('[google-disconnect] removing connection', {
        instanceId: instance.id,
        userId: user.id,
        accountEmail: existingConnection.account_email,
        accountSubject: existingConnection.account_subject,
        organizationId: organizationId ?? null,
      });
    }

    // Revoke broker credentials first so disconnect fails closed if any later
    // cleanup step errors.
    await clearKiloClawGoogleOAuthConnection(instance.id);

    const kiloclawClient = new KiloClawInternalClient();
    await kiloclawClient.clearGoogleOAuthConnection(user.id, instance.id);

    return NextResponse.redirect(
      new URL(buildDisconnectPath(organizationId, 'success=google_disconnected'), APP_URL),
      303
    );
  } catch (error) {
    console.error('Error disconnecting Google OAuth:', error);

    captureException(error, {
      tags: {
        endpoint: 'google/disconnect',
        source: 'google_oauth',
      },
      extra: {
        organizationId,
      },
    });

    return NextResponse.redirect(
      new URL(buildDisconnectPath(organizationId, 'error=disconnect_failed'), APP_URL),
      303
    );
  }
}

export async function GET() {
  return NextResponse.redirect(new URL('/claw/settings?error=method_not_allowed', APP_URL));
}
