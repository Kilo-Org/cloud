import { Effect } from 'effect';
import type { AbortLike, FetchLike, HttpResponse } from '../../core/fetch.js';
import { ModelError } from '../../core/model.js';
import type { RetryPolicyService } from '../../core/retry.js';
import { TokenError, type TokenSourceService } from '../../core/token.js';

/**
 * Where a call gets the handle that cancels it.
 *
 * `AbortController` is a global in every runtime that has `fetch`, and this
 * package requires the caller to supply a `fetch`, so it is read off the global
 * rather than made into a plugin of its own. A runtime that lacks it still
 * works: the call simply cannot be stopped early.
 */
interface AbortHandle {
  readonly signal: AbortLike;
  readonly abort: () => void;
}

interface AbortHost {
  readonly AbortController?: new () => AbortHandle;
}

const host: AbortHost = globalThis;

/**
 * A handle for one call, released when the caller stops listening.
 *
 * The release aborts whether the call ended or was interrupted. Aborting a
 * request whose body has already been read does nothing, and the alternative is
 * inspecting the exit for a case where the answer is the same.
 */
const abortHandle = (): Effect.Effect<AbortHandle | undefined> =>
  Effect.sync(() => (host.AbortController === undefined ? undefined : new host.AbortController()));

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

/**
 * The gateway's own name for the conversation a call belongs to.
 *
 * It is what the gateway turns into the upstream provider's cache key — a
 * `prompt_cache_key` on the OpenAI shapes, a `session_id` on OpenRouter's — and
 * it seeds the routing that keeps one conversation on one provider. Without it
 * the gateway has nothing to hash, so it sends neither, and a session's calls
 * are as unrelated to each other as two people's are.
 *
 * `x-kilocode-taskid` is the same field under the editor's name for it. This is
 * the one the gateway documents for everybody else, so this is the one a
 * harness sends.
 */
const sessionHeader = 'x-kilo-session';

const headersOf = (
  org: OrgContext,
  token: string,
  session: string | undefined
): Record<string, string> => ({
  'content-type': 'application/json',
  authorization: `Bearer ${token}`,
  ...(org.kind === 'organization' ? { [organizationHeader]: org.id } : {}),
  ...(session === undefined ? {} : { [sessionHeader]: session }),
});

/** A token that cannot be fetched is a transport failure, not a bad reply. */
const asModelError = (error: TokenError | ModelError): ModelError =>
  error instanceof TokenError ? new ModelError({ reason: 'transport', cause: error.cause }) : error;

/** One call: where it goes, what it carries, and what stops it. */
interface Sending {
  readonly path: string;
  readonly body: string;
  /** The conversation this call belongs to, for the gateway's cache key. */
  readonly session: string | undefined;
  /** Absent when the runtime has no `AbortController`. */
  readonly signal: AbortLike | undefined;
}

/**
 * Sends the body and returns the response once the status is good. The retry
 * stops here on purpose: the body has not been read yet, so a second try
 * repeats nothing the caller has already seen.
 *
 * The token is read inside the retried effect, so a retry that follows a 401
 * picks up whatever the token plugin supplies next.
 */
const post = (caller: HttpCaller, sending: Sending): Effect.Effect<HttpResponse, ModelError> =>
  caller.token.get().pipe(
    Effect.flatMap(token =>
      Effect.tryPromise({
        try: () =>
          caller.config.fetch(`${caller.config.baseUrl.replace(/\/+$/u, '')}${sending.path}`, {
            method: 'POST',
            headers: headersOf(caller.config.org, token, sending.session),
            body: sending.body,
            ...(sending.signal === undefined ? {} : { signal: sending.signal }),
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

export type { AbortHandle, HttpCaller, HttpConfig, OrgContext };
export { abortHandle, post };
