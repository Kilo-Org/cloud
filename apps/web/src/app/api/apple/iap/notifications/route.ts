import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { z } from 'zod';
import { processAppleIapNotification } from '@/lib/apple-iap/notifications';

const AppleIapNotificationRequestSchema = z.object({
  signedPayload: z.string().min(1),
});

export async function POST(req: Request): Promise<NextResponse<unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new NextResponse('Invalid JSON', { status: 400 });
  }

  const parsedBody = AppleIapNotificationRequestSchema.safeParse(body);
  if (!parsedBody.success) {
    return new NextResponse('Missing signedPayload', { status: 400 });
  }

  try {
    await processAppleIapNotification({ signedPayload: parsedBody.data.signedPayload });
    return new NextResponse('OK', { status: 200 });
  } catch (error) {
    captureException(error, { tags: { source: 'apple_iap_notification' } });
    return new NextResponse('Apple notification processing failed', { status: 400 });
  }
}
