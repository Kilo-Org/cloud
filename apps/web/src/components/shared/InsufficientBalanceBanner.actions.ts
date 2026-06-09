'use server';
import 'server-only';

import { setPaymentReturnUrl } from '@/lib/payment-return-url';

export async function setReturnUrlAndRedirect(returnUrl: string): Promise<void> {
  await setPaymentReturnUrl(returnUrl);
}
