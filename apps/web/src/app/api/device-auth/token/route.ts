import { NextResponse } from 'next/server';
import { consumeDeviceAuthByDeviceCode } from '@/lib/device-auth/device-auth';
import * as z from 'zod';
import { nativeCredentialFormatSchema } from '@kilocode/app-shared/native-auth';

const TokenBodySchema = z
  .object({
    deviceCode: z.string().min(1),
    supportsRefresh: z.boolean().optional(),
    credentialFormat: nativeCredentialFormatSchema.optional(),
  })
  .superRefine((data, context) => {
    if (data.credentialFormat && !data.supportsRefresh) {
      context.addIssue({
        code: 'custom',
        path: ['supportsRefresh'],
        message: 'supportsRefresh is required when credentialFormat is specified',
      });
    }
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

  const { deviceCode, supportsRefresh, credentialFormat } = validation.data;

  const result = await consumeDeviceAuthByDeviceCode(deviceCode, {
    supportsRefresh,
    ...(credentialFormat ? { credentialFormat } : {}),
  });

  switch (result.status) {
    case 'pending':
      return NextResponse.json({ status: 'pending' }, { status: 202 });

    case 'approved':
      return NextResponse.json(
        {
          status: 'approved',
          ...(result.token ? { token: result.token } : {}),
          ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
          ...(result.expiresIn ? { expiresIn: result.expiresIn } : {}),
          ...(result.metadata ? { metadata: result.metadata } : {}),
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
