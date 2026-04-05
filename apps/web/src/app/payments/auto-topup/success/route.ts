import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';

// This route just redirects to the profile page after Stripe checkout.
// All side effects (saving payment method, enabling auto-top-up, crediting balance)
// are handled by the Stripe webhook (charge.succeeded event) for reliability.
export async function GET(): Promise<NextResponse> {
  return NextResponse.redirect(new URL('/profile?auto_topup_setup=success', APP_URL));
}
