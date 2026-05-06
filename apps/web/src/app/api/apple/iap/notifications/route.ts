import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { processAppleIapNotification } from '@/lib/apple-iap/notifications';

export async function POST(req: Request): Promise<NextResponse<unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  const signedPayload =
    typeof body === 'object' &&
    body !== null &&
    'signedPayload' in body &&
    typeof body.signedPayload === 'string'
      ? body.signedPayload
      : null;

  if (!signedPayload) {
    return new NextResponse('Missing signedPayload', { status: 400 });
  }

  try {
    await processAppleIapNotification({ signedPayload });
    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    captureException(error, { tags: { source: 'apple_iap_notification' } });
    return new NextResponse('Apple notification processing failed', { status: 400 });
  }
}
