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
 * The requesting client named by the body, or null when it names none.
 * A body that names an unusable client is refused rather than trimmed, so the
 * page never shows a description the approver cannot decide on.
 */
async function readRequestingClient(request: Request): Promise<ReadRequestBodyResult> {
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
  const userAgent = headersList.get('user-agent') || undefined;
  const ipAddress = callerAddressOrNull(headersList) ?? undefined;

  const requestingClient = await readRequestingClient(request);
  if (!requestingClient.ok) {
    return NextResponse.json(
      {
        error: requestingClient.code,
        message: refusalCopyFor(requestingClient.code),
      },
      { status: 400 }
    );
  }

  if (
    requestingClient.pendingLinkToken &&
    !(await getPendingLinkBySecret(requestingClient.pendingLinkToken))
  ) {
    return NextResponse.json(
      {
        error: DEVICE_AUTH_REFUSAL_CODES.pendingLinkExpired,
        message: 'This sign-in link has expired. Start the sign-in again.',
      },
      { status: 400 }
    );
  }

  try {
    const {
      code,
      userCode,
      deviceCode,
      expiresAt,
      requestingClient: storedRequestingClient,
    } = await createDeviceAuthRequest({
      userAgent,
      ipAddress,
      ...(requestingClient.client ? { requestingClient: requestingClient.client } : {}),
      ...(requestingClient.pendingLinkToken
        ? { pendingLinkToken: requestingClient.pendingLinkToken }
        : {}),
    });

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
});
