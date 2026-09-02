import { NextResponse } from 'next/server';
import { approveDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromSessionForCredentialIssuance } from '@/lib/user/server';
import { APP_URL } from '@/lib/constants';
import * as z from 'zod';

const TokensSchema = z.object({
  code: z.string().min(1),
});

export async function POST(request: Request) {
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

  const { code } = validation.data;

  await approveDeviceAuthRequest(code, user.id);

  return NextResponse.json({ success: true });
}
