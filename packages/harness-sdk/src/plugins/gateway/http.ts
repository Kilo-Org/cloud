import { Effect } from 'effect';
import type { FetchLike, HttpResponse } from '../../core/fetch.js';
import { ModelError } from '../../core/model.js';
import type { RetryPolicyService } from '../../core/retry.js';
import { TokenError, type TokenSourceService } from '../../core/token.js';

/** Whose credit pays for the call. */
type OrgContext =
  | { readonly kind: 'personal' }
  | { readonly kind: 'organization'; readonly id: string };

interface HttpConfig {
  /** The gateway origin, such as `https://app.kilocode.ai`. */
  readonly baseUrl: string;
  readonly org: OrgContext;
  /** The caller passes `fetch`, so the package needs no runtime of its own. */
  readonly fetch: FetchLike;
}

/** The plugins one call resolves before it goes out. */
interface HttpPlugins {
  readonly token: TokenSourceService;
  readonly retry: RetryPolicyService;
}

/** Everything one call needs: where to send it, and which plugins shape it. */
interface HttpCaller extends HttpPlugins {
  readonly config: HttpConfig;
}

const organizationHeader = 'x-kilocode-organizationid';

const headersOf = (org: OrgContext, token: string): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...(org.kind === 'organization' ? { [organizationHeader]: org.id } : {}),
});

/** A token that cannot be fetched is a transport failure, not a bad reply. */
const asModelError = (error: TokenError | ModelError): ModelError =>
  error instanceof TokenError ? new ModelError({ reason: 'transport', cause: error.cause }) : error;

/**
 * Sends the body and returns the response once the status is good. The retry
 * stops here on purpose: the body has not been read yet, so a second try
 * repeats nothing the caller has already seen.
 *
 * The token is read inside the retried effect, so a retry that follows a 401
 * picks up whatever the token plugin supplies next.
 */
const post = (
  caller: HttpCaller,
  path: string,
  body: string
): Effect.Effect<HttpResponse, ModelError> =>
  caller.token.get().pipe(
    Effect.flatMap(token =>
      Effect.tryPromise({
        try: () =>
          caller.config.fetch(`${caller.config.baseUrl.replace(/\/+$/u, '')}${path}`, {
            method: 'POST',
            headers: headersOf(caller.config.org, token),
            body,
          }),
        catch: cause => new ModelError({ reason: 'transport', cause }),
      })
    ),
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
    Effect.mapError(asModelError),
    Effect.retry(caller.retry.schedule)
  );

export type { HttpCaller, HttpConfig, HttpPlugins, OrgContext };
export { post };
