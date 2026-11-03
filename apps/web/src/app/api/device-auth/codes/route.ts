import { NextResponse } from 'next/server';
import { z } from 'zod';
import {
  createDeviceAuthRequest,
  DeviceAuthPendingLimitError,
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

/**
 * The optional body of a pairing request. A caller that names the OAuth client
 * it is asking about gets that client shown on the approval page and confirmed
 * by the approver; a caller that sends no body keeps the plain flow.
 */
const CreateCodesBodySchema = z.object({
  requesting_client: requestingClientSchema.optional(),
});

/**
 * The requesting client named by the body, or null when it names none.
 * A body that names an unusable client is refused rather than trimmed, so the
 * page never shows a description the approver cannot decide on.
 */
async function readRequestingClient(
  request: Request
): Promise<{ ok: true; client: RequestingClient | null } | { ok: false }> {
  const body: unknown = await request.json().catch(() => null);
  const parsed = CreateCodesBodySchema.safeParse(body ?? {});
  if (!parsed.success) return { ok: false };
  const payload = parsed.data.requesting_client;
  return { ok: true, client: payload ? toRequestingClient(payload) : null };
}

export const POST = withRestTiming('/api/device-auth/codes', async (request: Request) => {
  const headersList = await headers();
  const userAgent = headersList.get('user-agent') || undefined;
  const ipAddress = headersList.get('x-forwarded-for') || undefined;

  const requestingClient = await readRequestingClient(request);
  if (!requestingClient.ok) {
    return NextResponse.json({ error: 'Invalid requesting client' }, { status: 400 });
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
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }
});
