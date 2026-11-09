import { NextResponse } from 'next/server';
import {
  approveDeviceAuthRequest,
  DEVICE_AUTH_CLIENT_CONFIRMATION_MESSAGE,
} from '@/lib/device-auth/device-auth';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import * as z from 'zod';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';

const TokensSchema = z.object({
  code: z.string().min(1),
  /**
   * The client the approval page showed and the approver confirmed. Required
   * for a request that names a requesting client, ignored otherwise.
   */
  confirmed_client_id: z.string().min(1).optional(),
});

export const POST = withRestTiming('/api/device-auth/tokens', async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin !== new URL(APP_URL).origin) {
    return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  }

  const { user, authFailedResponse } = await getUserFromSessionForCredentialIssuance();

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const body = await request.json().catch(() => undefined);
  const validation = TokensSchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: validation.error.issues },
      { status: 400 }
    );
  }

  const { code, confirmed_client_id: confirmedClientId } = validation.data;

  try {
    await approveDeviceAuthRequest(code, user.id, {
      ...(confirmedClientId ? { confirmedClientId } : {}),
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === DEVICE_AUTH_CLIENT_CONFIRMATION_MESSAGE) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error.message === 'Device authorization request not found') {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      if (error.message === 'Device authorization request is not pending') {
        return NextResponse.json(
          { error: 'Device authorization request can no longer be approved' },
          { status: 409 }
        );
      }
      if (error.message === 'Device authorization request has expired') {
        return NextResponse.json({ error: error.message }, { status: 410 });
      }
    }
    throw error;
  }

  return NextResponse.json({ success: true });
});
