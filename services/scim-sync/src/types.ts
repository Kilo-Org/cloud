/**
 * Durable Object RPC and status shapes.
 *
 * These are internal contracts between the Worker and its Durable Object, not
 * data crossing an IO boundary, so they are plain types rather than Zod
 * schemas. The WorkOS response is validated by the SDK's own deserializers and
 * typed by its exported `Event` union; PostgreSQL rows are typed by Drizzle's
 * `$inferSelect` off the shared schema.
 */

/** Outcome of one poll, persisted so `/status` survives hibernation. */
export type PollResult = {
  at: string;
  /** Events returned by the request, all of which were logged. */
  eventCount: number;
  /** ID of the last event in the page, to copy into `WORKOS_EVENT_CURSOR`. */
  lastEventId: string | null;
  error: string | null;
};

export type ScimSyncDOStatus = {
  instance: string;
  environment: string;
  pollIntervalSeconds: number;
  cursor: string | null;
  nextAlarmAt: number | null;
  lastPoll: PollResult | null;
};

/**
 * Result of the `/status` PostgreSQL reachability probe.
 *
 * Deliberately carries no error detail. A driver error names the failing SQL
 * and its parameters, which belongs in Workers Logs rather than a response
 * body; whether the database answered, and how slowly, is all a probe needs to
 * report.
 */
export type DatabaseStatus = {
  reachable: boolean;
  organizationCount: number | null;
  latencyMs: number;
};
