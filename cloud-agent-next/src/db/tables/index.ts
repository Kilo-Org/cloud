/**
 * Table definitions barrel export for CloudAgentSession Durable Object.
 *
 * Re-exports all table schemas and interpolators for use in query modules.
 */

export {
  events,
  EventRecord,
  EventIdOnly,
  MaxIdResult,
  CountResult,
  type EventRecord as EventRecordType,
  type EventIdOnly as EventIdOnlyType,
  type MaxIdResult as MaxIdResultType,
  type CountResult as CountResultType,
} from './events.table.js';

export {
  execution_leases,
  ExecutionLeaseRecord,
  LeaseIdAndExpiry,
  LeaseIdOnly,
  type ExecutionLeaseRecord as ExecutionLeaseRecordType,
  type LeaseIdAndExpiry as LeaseIdAndExpiryType,
  type LeaseIdOnly as LeaseIdOnlyType,
} from './execution-leases.table.js';
