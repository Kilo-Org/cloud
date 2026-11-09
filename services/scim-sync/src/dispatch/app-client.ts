import type { z } from 'zod';

import { DirectorySyncConflictBodySchema, isTerminalConflictCode } from '@kilocode/scim-contracts';

import { REQUEST_TIMEOUT_MS } from '../util/constants';

/**
 * One call to the Kilo app's internal directory-sync endpoints, classified
 * into the outcome that decides what the loop does next.
 */

/**
 * Exactly one class per attempt:
 *
 * - `applied`: the call landed, so the event's next call may run and the
 *   cursor may be committed once they all have.
 * - `conflict`: a dependency the stream can still supply is missing. Hold the
 *   cursor and retry, bounded by `CONFLICT_RETRY_BUDGET_MS`, then park.
 * - `terminal`: nothing the directory can send repairs it. Park immediately.
 * - `unavailable`: the app could not apply the event, and nothing about the
 *   event says it is unapplicable. Hold the cursor and retry indefinitely;
 *   never park. A missing or wrong secret, a Worker deployed ahead of the app,
 *   and a bug in a request this Worker builds are all operator problems rather
 *   than bad events, and parking the stream over one would discard every event
 *   behind it.
 */
export type AttemptClass = 'applied' | 'conflict' | 'terminal' | 'unavailable';

export type AttemptOutcome = {
  class: AttemptClass;
  /** Null for a failure with no response: a network error or a timeout. */
  status: number | null;
  /** Present only for `conflict` and a terminal conflict. */
  code: string | null;
  /**
   * Why the attempt is not `applied`. Never an event's `data`: the reason is
   * logged, and a directory payload carries emails, names and raw IdP
   * attributes.
   */
  reason: string | null;
};

const APPLIED: AttemptOutcome = { class: 'applied', status: null, code: null, reason: null };

export type AppCallContext = {
  /** `BACKEND_API_URL`. */
  origin: string;
  /** `INTERNAL_API_SECRET`, sent as `x-internal-api-key`. */
  apiKey: string;
};

type CallInit = {
  method: 'PUT' | 'DELETE';
  /** Path under `origin`, already percent-encoded where it embeds an id. */
  path: string;
  /** Omitted for the two routes keyed entirely on their path. */
  body?: unknown;
  /** The 2xx body this route promises. */
  responseSchema: z.ZodType;
};

/**
 * Issues one request and classifies the result. No internal retry: the alarm
 * is the retry, so stretching one attempt over several here would hide the
 * failure and consume the drain budget.
 */
export async function callApp(ctx: AppCallContext, init: CallInit): Promise<AttemptOutcome> {
  const url = `${ctx.origin}${init.path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        'x-internal-api-key': ctx.apiKey,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Never follow a redirect. `x-internal-api-key` is a custom header, so
      // it is *not* stripped when a redirect crosses origins: a 3xx from
      // `BACKEND_API_URL` or an intermediary in front of it would hand the
      // shared internal secret to whatever origin the `Location` names, and
      // the body that origin returned would then be parsed as the route's
      // response. `'manual'` rather than `'error'` so the status is a value
      // here and the classification below can name it.
      redirect: 'manual',
    });
  } catch (error) {
    // A network error and a timeout are the same thing to the loop: the app
    // did not answer, so whether the event is applicable is still unknown.
    return {
      class: 'unavailable',
      status: null,
      code: null,
      reason: `${init.method} ${init.path} did not complete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (response.ok) {
    const parsed = init.responseSchema.safeParse(await readJson(response));
    if (parsed.success) return APPLIED;
    // The write landed — the status says so — but the body is not the contract
    // this Worker was built against, which means the app's deployment and this
    // one disagree. That is an operator problem rather than a bad event, so it
    // holds the cursor instead of parking: the routes are idempotent, so the
    // replay after a fix costs nothing.
    return {
      class: 'unavailable',
      status: response.status,
      code: null,
      reason: `${init.method} ${init.path} answered ${response.status} with a body that does not match the contract`,
    };
  }

  if (response.status === 409) {
    const conflict = DirectorySyncConflictBodySchema.safeParse(await readJson(response));
    if (!conflict.success) {
      // A 409 is the one status whose body decides the class, so one without a
      // code cannot be classified. Retryable is the direction that cannot lose
      // an event, and the retry budget parks it if it never clears.
      return {
        class: 'conflict',
        status: 409,
        code: null,
        reason: `${init.method} ${init.path} conflicted with no machine-readable code`,
      };
    }

    const { code, error } = conflict.data;
    return {
      class: isTerminalConflictCode(code) ? 'terminal' : 'conflict',
      status: 409,
      code,
      reason: `${init.method} ${init.path} conflicted: ${error}`,
    };
  }

  // A 3xx reached this Worker because redirects are refused above. The app's
  // internal routes answer the method they were called with, so a redirect is
  // either a misrouted origin or an intermediary that should not be in the
  // path — an operator problem, like a wrong secret, rather than a statement
  // about the event. Held, never parked, and never followed.
  if (response.status >= 300 && response.status < 400) {
    return {
      class: 'unavailable',
      status: response.status,
      code: null,
      reason: `${init.method} ${init.path} answered ${response.status} with a redirect, which is never followed`,
    };
  }

  // A 400 is retryable, which is not the obvious reading of the status.
  //
  // Two causes produce the same 400 and the loop cannot tell them apart: the
  // app's request schemas are `z.strictObject`, so a Worker deployed ahead of
  // the app — sending a field the app does not yet accept — is rejected with
  // exactly the status a malformed path or a genuinely bad body produces.
  // Deploy skew clears on its own the minute the app rolls out, so parking it
  // would discard events over a condition that resolves itself, and nothing
  // replays `parked_events`.
  //
  // `unavailable` rather than a bounded `conflict`: the skew window is
  // operational rather than per-event, so an hour's conflict budget could
  // expire mid-rollout and start parking, and a 400 indicts the *request*,
  // which is identical for every event of that type — a bounded path would
  // therefore park every event of that shape in sequence.
  //
  // The cost: a body no deploy will ever fix holds the stream indefinitely
  // instead of being stepped over. That is the right side to fail on, because
  // every body is built from the shared typed contract module with no user
  // input in it, so a permanently rejected one is a bug in this Worker —
  // an operator problem, like a wrong secret. `/status` reports the held
  // failure with the status and the reason, which is how it gets noticed.
  if (response.status === 400) {
    return {
      class: 'unavailable',
      status: 400,
      code: null,
      reason: `${init.method} ${init.path} rejected the request body`,
    };
  }

  // Everything else — 401 and 403 (secret), 408 and 429 (load), 5xx, and any
  // status this Worker does not model — says the app could not apply the
  // event, not that the event is bad. 404 belongs here too: a route that is
  // not answering is a deployment to fix, and parking the stream over it
  // would discard every event behind it.
  return {
    class: 'unavailable',
    status: response.status,
    code: null,
    reason: `${init.method} ${init.path} answered ${response.status}`,
  };
}

/**
 * Bodies here are small and the app always answers JSON, but a 5xx from an
 * edge in front of it may not, so a parse failure is a value rather than a
 * throw: the status has already decided the class in every case that matters.
 */
async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
