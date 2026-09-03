import { Effect, Schedule } from 'effect';
import type { FetchLike, HttpResponse } from '../../core/fetch.js';
import { ModelError } from '../../core/model.js';

/** Whose credit pays for the call. */
type OrgContext =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly id: string };

interface HttpConfig {
  /** The gateway origin, such as `https://app.kilocode.ai`. */
  readonly baseUrl: string;
  /** The user token, sent as a bearer token. */
  readonly token: string;
  readonly org: OrgContext;
  /** The caller passes `fetch`, so the package needs no runtime of its own. */
  readonly fetch: FetchLike;
  /** How many times a failed call is tried again. Defaults to three. */
  readonly retries?: number;
}

const organizationHeader = 'x-kilocode-organizationid';

const headersOf = ({ token, org }: HttpConfig): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...(org.kind === 'organization' ? { [organizationHeader]: org.id } : {}),
});

/** A status the gateway or the network may recover from on its own. */
const retryStatuses = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const isRetryable = (error: ModelError): boolean =>
  error.reason === 'transport' ||
  (error.reason === 'status' && retryStatuses.has(error.status ?? 0));

const scheduleOf = (retries: number) =>
  Schedule.exponential('200 millis').pipe(
    Schedule.jittered,
    Schedule.whileInput(isRetryable),
    Schedule.intersect(Schedule.recurs(retries))
  );

/**
 * Sends the body and returns the response once the status is good. The retry
 * stops here on purpose: the body has not been read yet, so a second try
 * repeats nothing the caller has already seen.
 */
const post = (
  config: HttpConfig,
  path: string,
  body: string
): Effect.Effect<HttpResponse, ModelError> =>
  Effect.tryPromise({
    try: () =>
      config.fetch(`${config.baseUrl.replace(/\/+$/u, '')}${path}`, {
        method: 'POST',
        headers: headersOf(config),
        body,
      }),
    catch: cause => new ModelError({ reason: 'transport', cause }),
  }).pipe(
    Effect.flatMap(response =>
      response.ok
        ? Effect.succeed(response)
        : Effect.tryPromise({
            try: () => response.text(),
            catch: cause => cause,
          }).pipe(
            Effect.merge,
            Effect.flatMap(cause =>
              Effect.fail(new ModelError({ reason: 'status', status: response.status, cause }))
            )
          )
    ),
    Effect.retry(scheduleOf(config.retries ?? 3))
  );

export type { HttpConfig, OrgContext };
export { post };
