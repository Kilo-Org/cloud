import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createDeviceAuthRequest,
  DEVICE_AUTH_REFUSAL_CODES,
  DeviceAuthPendingLimitError,
  refusalCopyFor,
  type DeviceAuthRefusalCode,
} from '@/lib/device-auth/device-auth';
import {
  requestingClientSchema,
  toRequestingClient,
  type RequestingClient,
} from '@/lib/device-auth/requesting-client';
import { headers } from 'next/headers';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import {
  buildDeviceAuthVerificationUrl,
  getDeviceAuthAppModeFromRequestUrl,
} from '@/app/device-auth/device-auth-url';
import { withRestTiming } from '@kilocode/web-shared/lib/observability/request-timing';
import { callerAddressOrNull } from '@/lib/auth/caller-address';
import { getPendingLinkBySecret } from '@/lib/auth/pending-link';
import {
  auditAuthRoute,
  authAuditRequestFromHeaders,
  type AuthAuditAttempt,
} from '@/lib/auth/auth-audit';

/**
 * The optional body of a pairing request. A caller that names the OAuth client
 * it is asking about gets that client shown on the approval page and confirmed
 * by the approver. A caller that sends no body keeps the plain flow; a body
 * that cannot be read is refused; a field that fails its schema is named by its
 * own refusal code.
 */
const CreateCodesBodySchema = z.object({
  requesting_client: requestingClientSchema.optional(),
  pendingLinkToken: z.string().trim().min(1).max(512).optional(),
});

type ReadRequestBodyResult =
  | { ok: true; client: RequestingClient | null; pendingLinkToken?: string }
  | { ok: false; code: DeviceAuthRefusalCode };

/**
 * The pairing request a caller sent: the client it names, the pending link it
 * carries, or the reason the body could not be used.
 *
 * No body at all keeps the plain flow, because the shipped clients send none. A
 * named client that fails its schema is refused rather than trimmed, so the page
 * never shows a description the approver cannot decide on. The failing field
 * decides which refusal names it.
 */
async function readPairingBody(request: Request): Promise<ReadRequestBodyResult> {
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { ok: false, code: DEVICE_AUTH_REFUSAL_CODES.invalidRequestBody };
  }

  if (rawBody.trim() === '') return { ok: true, client: null };

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: DEVICE_AUTH_REFUSAL_CODES.invalidRequestBody };
  }

  // A client that serializes an empty payload as `null` is still sending no
  // pairing request, so it keeps the plain flow the way an absent body does.
  if (body === null) return { ok: true, client: null };

  const parsed = CreateCodesBodySchema.safeParse(body);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (field === 'requesting_client') {
      return { ok: false, code: DEVICE_AUTH_REFUSAL_CODES.invalidRequestingClient };
    }
    if (field === 'pendingLinkToken') {
      return { ok: false, code: DEVICE_AUTH_REFUSAL_CODES.pendingLinkInvalid };
    }
    return { ok: false, code: DEVICE_AUTH_REFUSAL_CODES.invalidRequestBody };
  }

  const payload = parsed.data.requesting_client;
  return {
    ok: true,
    client: payload ? toRequestingClient(payload) : null,
    ...(parsed.data.pendingLinkToken ? { pendingLinkToken: parsed.data.pendingLinkToken } : {}),
  };
}

export const POST = withRestTiming('/api/device-auth/codes', async (request: Request) => {
  const headersList = await headers();
  const attempt: AuthAuditAttempt = { action: 'auth.device_auth.create' };
  return auditAuthRoute(
    authAuditRequestFromHeaders(headersList, '/api/device-auth/codes'),
    attempt,
    () => createPairing(request, headersList, attempt)
  );
});

async function createPairing(
  request: Request,
  headersList: Headers,
  attempt: AuthAuditAttempt
): Promise<Response> {
  const userAgent = headersList.get('user-agent') || undefined;
  const ipAddress = callerAddressOrNull(headersList) ?? undefined;

  const pairingBody = await readPairingBody(request);
  if (!pairingBody.ok) {
    return NextResponse.json(
      {
        error: pairingBody.code,
        message: refusalCopyFor(pairingBody.code),
      },
      { status: 400 }
    );
  }

  if (
    pairingBody.pendingLinkToken &&
    !(await getPendingLinkBySecret(pairingBody.pendingLinkToken))
  ) {
    return NextResponse.json(
      {
        error: DEVICE_AUTH_REFUSAL_CODES.pendingLinkExpired,
        message: refusalCopyFor(DEVICE_AUTH_REFUSAL_CODES.pendingLinkExpired),
      },
      { status: 400 }
    );
  }

  try {
    const {
      requestId,
      code,
      userCode,
      deviceCode,
      expiresAt,
      requestingClient: storedRequestingClient,
    } = await createDeviceAuthRequest({
      userAgent,
      ipAddress,
      ...(pairingBody.client ? { requestingClient: pairingBody.client } : {}),
      ...(pairingBody.pendingLinkToken ? { pendingLinkToken: pairingBody.pendingLinkToken } : {}),
    });
    attempt.metadata = { deviceAuthRequestId: requestId };

    const verificationUrl = buildDeviceAuthVerificationUrl(APP_URL, userCode, {
      app: getDeviceAuthAppModeFromRequestUrl(request.url),
    });

    return NextResponse.json({
      code,
      user_code: userCode,
      device_code: deviceCode,
      verificationUrl,
      expiresIn: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
      requestingClient: storedRequestingClient,
    });
  } catch (error) {
    if (error instanceof DeviceAuthPendingLimitError) {
      return NextResponse.json(
        {
          error: DEVICE_AUTH_REFUSAL_CODES.rateLimited,
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } }
      );
    }
    throw error;
  }
}
