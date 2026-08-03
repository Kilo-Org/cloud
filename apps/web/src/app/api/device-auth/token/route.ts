import { NextResponse } from 'next/server';
import { consumeDeviceAuthByDeviceCode } from '@/lib/device-auth/device-auth';
import * as z from 'zod';

const TokenBodySchema = z.object({
  deviceCode: z.string().min(1),
  supportsRefresh: z.boolean().optional(),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = TokenBodySchema.safeParse(body);
  if (!validation.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: validation.error.issues },
      { status: 400 }
    );
  }

  const { deviceCode, supportsRefresh } = validation.data;

  const result = await consumeDeviceAuthByDeviceCode(deviceCode, { supportsRefresh });

  switch (result.status) {
    case 'pending':
      return NextResponse.json({ status: 'pending' }, { status: 202 });

    case 'approved':
      return NextResponse.json(
        {
          status: 'approved',
          token: result.token,
          userId: result.userId,
          userEmail: result.userEmail,
        },
        { status: 200 }
      );

    case 'denied':
      return NextResponse.json({ status: 'denied' }, { status: 403 });

    case 'expired':
    case 'consumed':
      return NextResponse.json({ status: 'expired' }, { status: 410 });

    default:
      return NextResponse.json({ error: 'Unknown status' }, { status: 500 });
  }
}
