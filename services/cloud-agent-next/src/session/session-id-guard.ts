import { TRPCError } from '@trpc/server';
import { isControlSession } from '../session-plane.js';

export function assertControlSessionId(sessionId: string): void {
  if (!isControlSession(sessionId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
  }
}
