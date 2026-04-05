import { NextResponse } from 'next/server';
import { pollDeviceAuthRequest, denyDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromAuth } from '@/lib/user.server';

type RouteContext = {
  params: Promise<{ code: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { code } = await context.params;

  if (!code) {
    return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
  }

  const result = await pollDeviceAuthRequest(code);

  // Return appropriate status codes based on the result
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
      return NextResponse.json({ status: 'expired' }, { status: 410 });

    default:
      return NextResponse.json({ error: 'Unknown status' }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  // Authenticate the user
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: false });

  if (authFailedResponse) {
    return authFailedResponse;
  }

  const { code } = await context.params;

  if (!code) {
    return NextResponse.json({ error: 'Code parameter is required' }, { status: 400 });
  }

  await denyDeviceAuthRequest(code);

  return NextResponse.json({ success: true });
}
