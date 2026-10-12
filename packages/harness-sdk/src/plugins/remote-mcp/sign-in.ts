import {
  auth,
  type OAuthClientProvider,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Effect } from 'effect';
import { ended } from './credential.js';
import { failed } from './failure.js';
import { bounded, makeDeadline, type RemoteMcpAbort, type RemoteMcpRequest } from './http.js';
import type { RemoteMcpError, RemoteMcpServer } from './server.js';

/** How long a sign-in may take, the person's time in the browser included. */
const defaultSignInTimeoutMs = 5 * 60_000;

/** The library's OAuth provider, plus the code its redirect brought back. */
interface RemoteMcpSignInProvider extends OAuthClientProvider {
  /** The code the last redirect carried, handed over once. None when the person turned back. */
  takeAuthorizationCode(): string | undefined;
}

interface RemoteMcpSignInDeps {
  fetch(url: string | URL, init?: RemoteMcpRequest): Promise<Response>;
  authProvider: RemoteMcpSignInProvider;
  signal?: RemoteMcpAbort;
  /** How long the whole sign-in may take. Five minutes by default. */
  timeoutMs?: number;
}

/**
 * Signs a person in to an `oauth` server.
 *
 * The library does the protocol: it discovers the authorization server
 * (RFC 9728, RFC 8414), registers the app (RFC 7591) when the provider holds
 * no client, and refreshes a stored token when it can. Only when it cannot
 * does it call `redirectToAuthorization`, which opens the browser; the code
 * that comes back is exchanged for tokens the provider saves. A person who
 * turns back leaves no code, and the sign-in fails `unauthorized`.
 */
const remoteMcpSignIn = (
  server: RemoteMcpServer,
  deps: RemoteMcpSignInDeps
): Effect.Effect<void, RemoteMcpError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const deadline = yield* Effect.acquireRelease(
        Effect.sync(() => makeDeadline(deps.timeoutMs ?? defaultSignInTimeoutMs, deps.signal)),
        made => Effect.sync(made.stop)
      );
      const options = { serverUrl: server.url, fetchFn: bounded(deps, deadline) };
      /* Raced against the deadline, because the browser wait inside
         `redirectToAuthorization` is the caller's and no request signal reaches it. */
      const signedIn = Effect.tryPromise({
        try: async () => {
          if ((await auth(deps.authProvider, options)) === 'AUTHORIZED') {
            return;
          }
          const authorizationCode = deps.authProvider.takeAuthorizationCode();
          if (authorizationCode === undefined) {
            throw new UnauthorizedError('the sign-in ended without an authorization code');
          }
          if ((await auth(deps.authProvider, { ...options, authorizationCode })) !== 'AUTHORIZED') {
            throw new UnauthorizedError('the authorization server did not issue a token');
          }
        },
        catch: cause => failed(server, cause),
      });
      yield* Effect.raceFirst(signedIn, ended(server, deadline));
    })
  );

export type { RemoteMcpSignInDeps, RemoteMcpSignInProvider };
export { remoteMcpSignIn };
