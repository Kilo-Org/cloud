import { readConsent } from '@/lib/consent';

type ConsentGateResult =
  | { readonly status: 'accepted'; readonly optional: boolean }
  | { readonly status: 'needs-consent' }
  | { readonly status: 'error'; readonly error: unknown };

export async function checkConsentGate(userId: string): Promise<ConsentGateResult> {
  try {
    const consent = await readConsent(userId);
    return consent.mandatory
      ? { status: 'accepted', optional: consent.optional }
      : { status: 'needs-consent' };
  } catch (error) {
    return { status: 'error', error };
  }
}
