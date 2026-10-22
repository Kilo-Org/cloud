import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { processStripePaymentEventHook } from '@/lib/stripe';
import { captureException } from '@sentry/nextjs';
import { client } from '@kilocode/web-shared/lib/stripe-client';
import Stripe from 'stripe';

export async function POST(req: Request): Promise<NextResponse<unknown>> {
  const body = await req.text();
  const signature = (await headers()).get('stripe-signature');

  if (!signature) {
    return new NextResponse('Webhook Error', { status: 400 });
  }

  if (!getEnvVariable('STRIPE_WEBHOOK_SECRET')) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return new NextResponse('Missing STRIPE_WEBHOOK_SECRET', { status: 500 });
  }

  try {
    let event: Stripe.Event;
    try {
      event = client.webhooks.constructEvent(
        body,
        signature,
        getEnvVariable('STRIPE_WEBHOOK_SECRET')
      );
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
        return new NextResponse('Webhook Error', { status: 400 });
      }
      throw err;
    }
    await processStripePaymentEventHook(event);
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    captureException(err);
    return new NextResponse(`Webhook Error: ${errorMessage}`, { status: 400 });
  }

  return new NextResponse('OK', { status: 200 });
}
