'use server';
import 'server-only';

import { setPaymentReturnUrl } from '@/lib/payment-return-url';

export async function setClawReturnUrl(modelId: string, returnPath = '/claw/new'): Promise<void> {
  await setPaymentReturnUrl(`${returnPath}?model=${encodeURIComponent(modelId)}&payment=success`);
}
