import dispatcherCalls from '../fixtures/dispatcher-calls.json';
import directoryEvents from '../fixtures/workos-directory-events.json';

/**
 * The cross-deployment seam between the `scim-sync` Worker and this app's
 * internal directory-sync routes, pinned as data so both halves can be tested
 * against the same bytes rather than against a fake of each other.
 *
 * Two files, one producer and one consumer:
 *
 * - `workos-directory-events.json` is a recorded range of the real WorkOS
 *   Events API stream, in its raw snake_case wire format. It is served to the
 *   real SDK, so the real deserializer runs on it.
 * - `dispatcher-calls.json` is the ordered `{ method, path, body }` the real
 *   dispatcher emits for each of those events. The Worker's producer test
 *   re-records it and asserts equality; the app's consumer test replays it
 *   against the real route handlers.
 *
 * Both files live here, beside the schemas the two sides already share,
 * because neither side owns them. See `fixtures/README.md`.
 */

/**
 * One event exactly as the Events API returns it. Deliberately unparsed: the
 * whole point is that the real SDK deserializer, not this type, decides what
 * the dispatcher sees.
 */
export type WorkOSWireEvent = {
  /** `event_…`. Also the Events API cursor. */
  id: string;
  /** `dsync.activated`, `dsync.group.user_added`, … */
  event: string;
  [field: string]: unknown;
};

export type WorkOSEventRange = {
  /** First event id in the recorded range. */
  rangeStart: string;
  /** Last event id in the recorded range. */
  rangeEnd: string;
  recordedAt: string;
  events: readonly WorkOSWireEvent[];
};

/** One HTTP call the dispatcher made to the app. */
export type RecordedDispatcherCall = {
  method: 'PUT' | 'DELETE';
  /** Path only: the origin is the Worker's `BACKEND_API_URL`. */
  path: string;
  /** `null` for the routes the dispatcher calls with no body. */
  body: unknown;
};

/**
 * Every call one event produced, in order. An empty list is an event the
 * dispatcher answers without asking the app anything, which the recorded range
 * happens not to contain.
 */
export type RecordedDispatcherEvent = {
  eventId: string;
  eventType: string;
  calls: readonly RecordedDispatcherCall[];
};

export type DispatcherCallContract = {
  /** The event fixture these calls were recorded from. */
  generatedFrom: string;
  events: readonly RecordedDispatcherEvent[];
};

export const workOSDirectoryEvents = directoryEvents as WorkOSEventRange;

export const dispatcherCallContract = dispatcherCalls as DispatcherCallContract;

/** Flattens the contract to the call sequence a replay issues, in stream order. */
export function recordedDispatcherCalls(): RecordedDispatcherCall[] {
  return dispatcherCallContract.events.flatMap(event => [...event.calls]);
}
