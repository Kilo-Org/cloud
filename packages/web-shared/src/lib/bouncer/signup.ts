import 'server-only';

import { createHash } from 'crypto';

/** Shared by live admission and history import; never send the normalized email to Bouncer. */
export function signupOperationId(normalizedEmail: string): string {
  return `signup:${createHash('sha256').update(normalizedEmail).digest('hex')}`;
}
