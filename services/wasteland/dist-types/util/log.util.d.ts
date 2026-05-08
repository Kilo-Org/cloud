/**
 * Structured logging powered by workers-tagged-logger.
 *
 * Uses AsyncLocalStorage so tags (wastelandId, userId, etc.) propagate
 * to all downstream functions without explicit parameter passing.
 *
 * Setup:
 *   - In the Hono worker: use `useWorkersLogger` middleware to establish context.
 *   - In DOs: wrap the entry point (alarm, RPC) with `withLogTags`.
 *   - Anywhere: call `logger.setTags({ wastelandId })` to tag all subsequent logs.
 *
 * Usage:
 *   import { logger } from '../util/log.util';
 *   logger.info('initializeWasteland: stored config');
 *   logger.warn('storeCredential: missing token', { userId });
 */
import { WorkersLogger, withLogTags } from 'workers-tagged-logger';
export type LogTags = {
    source?: string;
    wastelandId?: string;
    userId?: string;
    memberId?: string;
};
export declare const logger: WorkersLogger<LogTags>;
export { withLogTags };
