/**
 * Structured logging powered by workers-tagged-logger.
 *
 * Uses AsyncLocalStorage so tags (callerId, etc.) propagate to all downstream
 * functions without explicit parameter passing.
 *
 * Setup:
 *   - In the Hono worker: use `useWorkersLogger` middleware to establish context.
 *   - In DOs: wrap the entry point (alarm, RPC) with `withLogTags`.
 *   - Anywhere: call `logger.setTags({ callerId })` to tag all subsequent logs.
 */

import { WorkersLogger, withLogTags } from 'workers-tagged-logger';

export type LogTags = {
  source?: string;
  callerId?: string;
  callerKind?: 'user';
  badgeBucket?: string;
};

export const logger = new WorkersLogger<LogTags>();
export { withLogTags };
