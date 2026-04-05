import { NextResponse } from 'next/server';
import { approveDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user.server';
import * as z from 'zod';

const TokensSchema = z.object({
  code: z.string().min(1),
});

export async function POST(request: Request) {
  // Authenticate the user
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const body = await request.json();
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
