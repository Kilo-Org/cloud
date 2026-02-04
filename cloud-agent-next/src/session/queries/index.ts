/**
 * Query modules for CloudAgentSession Durable Object.
 *
 * These modules provide type-safe operations for the DO storage.
 * - Events and Leases use SQLite storage
 * - Executions use key-value storage
 *
 * @example
 * ```ts
 * import { createEventQueries, createLeaseQueries, createExecutionQueries } from './queries/index.js';
 *
 * const events = createEventQueries(ctx.storage.sql);
 * const leases = createLeaseQueries(ctx.storage.sql);
 * const executions = createExecutionQueries(ctx.storage);
 * ```
 */

export {
  createEventQueries,
  type EventQueries,
  type InsertEventParams,
  type EventQueryFilters,
} from './events.js';

export {
  createLeaseQueries,
  type LeaseQueries,
  type LeaseRecord,
  type LeaseAcquireError,
  type LeaseExtendError,
} from './leases.js';

export {
  createExecutionQueries,
  type ExecutionQueries,
  type AddExecutionError,
  type UpdateStatusError,
  type SetActiveError,
} from './executions.js';
