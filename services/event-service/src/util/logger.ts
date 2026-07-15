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
 *
 * Debug logs are suppressed by default (minimumLogLevel: 'info'). Local dev
 * opts in per-request via configureDevLogging(), which raises the current
 * context to 'debug' when WORKER_ENV === 'development'. Production never opts
 * in, so debug calls are no-ops there.
 */

import { WorkersLogger, withLogTags } from 'workers-tagged-logger';

export type LogTags = {
  source?: string;
  userId?: string;
  context?: string;
  event?: string;
};

export const logger = new WorkersLogger<LogTags>({ minimumLogLevel: 'info' });

/**
 * Enable debug-level logs for the current async context in local dev only.
 * Call inside a withLogTags/useWorkersLogger context (per request entry point).
 * No-op in production, so debug logs never ship there.
 */
export function configureDevLogging(env: { WORKER_ENV?: string }): void {
  if (env.WORKER_ENV === 'development') logger.setLogLevel('debug');
}

export { withLogTags };
