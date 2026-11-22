// The blocked-account surface's Contact support action. A bare support address
// makes the person write the account they are stuck on from memory, on a device
// where that read is exactly what the server refused; the draft therefore
// carries it, plus the screen's own title as the subject so the reply threads
// start from the symptom.
//
// Pure: the caller supplies both values, so this never reads auth state and is
// testable without a running session.

import { SUPPORT_EMAIL } from '@kilocode/app-shared/support';

/**
 * The support draft link for a blocked account. `email` is the person's OWN
 * address, already known to the app, and is only used here to prefill their
 * mail app's body line — nothing is sent anywhere until they send it. An
 * absent or empty value is omitted rather than replaced: the identity read is
 * usually what got refused, so there is often no address to name.
 */
export function buildBlockedAccountSupportLink(input: {
  subject?: string | undefined;
  email?: string | undefined;
}): string {
  const params: string[] = [];
  if (input.subject) {
    params.push(`subject=${encodeURIComponent(input.subject)}`);
  }
  if (input.email) {
    params.push(`body=${encodeURIComponent(`Account: ${input.email}`)}`);
  }
  const base = `mailto:${SUPPORT_EMAIL}`;
  return params.length === 0 ? base : `${base}?${params.join('&')}`;
}
