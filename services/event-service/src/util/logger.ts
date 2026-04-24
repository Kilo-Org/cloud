/**
 * Structured logging powered by workers-tagged-logger.
 *
 * Uses AsyncLocalStorage so tags (userId, context, event) propagate
 * to all downstream functions without explicit parameter passing.
 *
 * Setup:
 *   - In the Hono worker: use `useWorkersLogger` middleware to establish context.
 *   - In DOs: wrap the entry point with `withLogTags`.
 *   - Anywhere: call `logger.setTags({ userId })` to tag all subsequent logs.
 */

import { WorkersLogger, withLogTags } from 'workers-tagged-logger';

export type LogTags = {
  source?: string;
  userId?: string;
  context?: string;
  event?: string;
};

export const logger = new WorkersLogger<LogTags>();
export { withLogTags };
