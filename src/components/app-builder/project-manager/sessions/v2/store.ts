/**
 * V2 session store — thin re-export of the generic session store
 * parameterized with StoredMessage.
 */

import type { StoredMessage } from '@/components/cloud-agent-next/types';
import { createSessionStore } from '../session-store';

export type { V2SessionStore } from '../types';

export function createV2SessionStore(initialMessages: StoredMessage[]) {
  return createSessionStore(initialMessages);
}
