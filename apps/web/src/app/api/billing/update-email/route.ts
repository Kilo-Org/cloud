import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { client as stripeClient } from '@/lib/stripe-client';
import { captureException } from '@sentry/nextjs';

export async function POST(request: NextRequest) {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const { email } = await request.json();

  if (!email || typeof email !== 'string') {
    return NextResponse.json({ error: 'Valid email is required' }, { status: 400 });
  }

  try {
    await stripeClient.customers.update(user.stripe_customer_id, {
      email,
      metadata: {
        send_billing_email: 'true',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: {
        action: 'update_billing_email',
        userId: user.id,
      },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to update billing email' },
      { status: 500 }
    );
  }

  return NextResponse.json({ success: true, message: 'Billing email updated successfully' });
}
