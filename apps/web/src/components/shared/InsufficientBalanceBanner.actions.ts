'use server';
import 'server-only';

import { setPaymentReturnUrl } from '@/lib/payment-return-url';

export async function setReturnUrlAndRedirect(
  returnUrl: string,
  creditsUrl: string
): Promise<string> {
  await setPaymentReturnUrl(returnUrl);
  return creditsUrl;
}
