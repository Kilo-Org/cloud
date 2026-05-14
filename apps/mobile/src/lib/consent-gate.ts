import { hasAcceptedConsent } from '@/lib/consent';

type ConsentGateResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'needs-consent' }
  | { readonly status: 'error'; readonly error: unknown };

export async function checkConsentGate(userId: string): Promise<ConsentGateResult> {
  try {
    const accepted = await hasAcceptedConsent(userId);
    return accepted ? { status: 'accepted' } : { status: 'needs-consent' };
  } catch (error) {
    return { status: 'error', error };
  }
}
