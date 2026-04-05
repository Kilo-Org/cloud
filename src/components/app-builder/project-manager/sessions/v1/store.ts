/**
 * V1 session store — thin re-export of the generic session store
 * parameterized with CloudMessage.
 */

import type { CloudMessage } from '@/components/cloud-agent/types';
import { createSessionStore } from '../session-store';

export type { V1SessionStore } from '../types';

export function createV1SessionStore(initialMessages: CloudMessage[]) {
  return createSessionStore(initialMessages);
}
