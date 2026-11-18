import 'server-only';

import type { User } from '@kilocode/db/schema';
import { createControlTokenForRequest } from '@/lib/auth/resource-delegation';

// createTRPCContext supplies a new Headers object per request. Weak keys keep
// this memo within that request, including concurrent members of a tRPC batch.
const tokensByRequest = new WeakMap<Headers, WeakMap<User, Promise<string>>>();

export function createCloudAgentControlToken(user: User, headers?: Headers): Promise<string> {
  const issue = async () =>
    (
      await createControlTokenForRequest(user, 'cloud-agent-next', {
        headers,
        tokenSource: 'cloud-agent',
      })
    ).token;
  if (!headers) return issue();
  let tokens = tokensByRequest.get(headers);
  if (!tokens) {
    tokens = new WeakMap();
    tokensByRequest.set(headers, tokens);
  }
  const cached = tokens.get(user);
  if (cached) return cached;
  const requestTokens = tokens;
  const pending = issue().catch(error => {
    requestTokens.delete(user);
    throw error;
  });
  tokens.set(user, pending);
  return pending;
}
