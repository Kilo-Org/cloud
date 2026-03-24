'use server';
import 'server-only';

import { setPaymentReturnUrl } from '@/lib/payment-return-url';

export async function setClawReturnUrl(modelId: string): Promise<void> {
  await setPaymentReturnUrl(`/claw?model=${encodeURIComponent(modelId)}&payment=success`);
}
