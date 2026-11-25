import { NextResponse } from 'next/server';
import {
  approveDeviceAuthRequest,
  DEVICE_AUTH_REFUSAL_CODES,
  DeviceAuthRefusalError,
  refusalCopyFor,
  type DeviceAuthRefusalCode,
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
  /**
   * The approver's choice for a request carrying a pending account link:
   * true attaches it on consumption, false approves without attaching.
   * Required when the request carries a live pending link.
   */
  add_pending_link: z.boolean().optional(),
  /**
   * The code emailed for adding the pending link, and its challenge. Required
   * to add a pending link to an existing account.
   */
  pending_link_code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  pending_link_challenge_id: z.uuid().optional(),
});

/** The HTTP status each approval refusal answers with. A refusal missing here is a bug, not a 500. */
const APPROVAL_REFUSAL_STATUS: Partial<Record<DeviceAuthRefusalCode, number>> = {
  [DEVICE_AUTH_REFUSAL_CODES.requestNotFound]: 404,
  [DEVICE_AUTH_REFUSAL_CODES.requestExpired]: 410,
  [DEVICE_AUTH_REFUSAL_CODES.requestNotPending]: 409,
  [DEVICE_AUTH_REFUSAL_CODES.clientConfirmationMismatch]: 409,
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkChoiceRequired]: 409,
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkCodeInvalid]: 400,
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkCodeLocked]: 429,
  [DEVICE_AUTH_REFUSAL_CODES.pendingLinkReauthRequired]: 403,
};

export const POST = withRestTiming('/api/device-auth/tokens', async (request: Request) => {
  const origin = request.headers.get('origin');
  if (origin !== new URL(APP_URL).origin) {
    return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  }

  const session = await getUserFromSessionForCredentialIssuance();
  const { user, authFailedResponse } = session;

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

  const {
    code,
    confirmed_client_id: confirmedClientId,
    add_pending_link: addPendingLink,
    pending_link_code: pendingLinkCode,
    pending_link_challenge_id: pendingLinkChallengeId,
  } = validation.data;

  try {
    await approveDeviceAuthRequest(code, user.id, {
      ...(confirmedClientId ? { confirmedClientId } : {}),
      ...(addPendingLink !== undefined ? { addPendingLink } : {}),
      ...(addPendingLink
        ? {
            pendingLinkProof: {
              email: user.google_user_email,
              webSessionId: session.webSessionId,
              ...(pendingLinkCode ? { code: pendingLinkCode } : {}),
              ...(pendingLinkChallengeId ? { challengeId: pendingLinkChallengeId } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof DeviceAuthRefusalError) {
      const status = APPROVAL_REFUSAL_STATUS[error.code];
      if (status !== undefined) {
        return NextResponse.json(
          { error: error.code, message: refusalCopyFor(error.code) },
          { status }
        );
      }
    }
    throw error;
  }

  return NextResponse.json({ success: true });
});
