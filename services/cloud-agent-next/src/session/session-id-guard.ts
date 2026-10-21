import { TRPCError } from '@trpc/server';
import type { SessionId } from '../types.js';
import { isControlSession } from '../session-identity.js';

export function assertControlSessionId(sessionId: string): asserts sessionId is SessionId {
  if (!isControlSession(sessionId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
}
