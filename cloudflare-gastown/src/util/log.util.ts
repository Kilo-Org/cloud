/**
 * Structured logging powered by workers-tagged-logger.
 *
 * Uses AsyncLocalStorage so tags (townId, rigId, userId, etc.) propagate
 * to all downstream functions without explicit parameter passing.
 *
 * Setup:
 *   - In the Hono worker: use `useWorkersLogger` middleware to establish context.
 *   - In DOs: wrap the entry point (alarm, RPC) with `withLogTags`.
 *   - Anywhere: call `logger.setTags({ townId })` to tag all subsequent logs.
 *
 * Usage:
 *   import { logger } from '../util/log.util';
 *   logger.info('configureRig: stored token');
 *   logger.warn('ensureMayor: no kilocodeToken', { userId });
 */

import { WorkersLogger, withLogTags } from 'workers-tagged-logger';

export type LogTags = {
  source?: string;
  townId?: string;
  rigId?: string;
  userId?: string;
  orgId?: string;
  agentId?: string;
  beadId?: string;
  convoyId?: string;
};

export const logger = new WorkersLogger<LogTags>();
export { withLogTags };
