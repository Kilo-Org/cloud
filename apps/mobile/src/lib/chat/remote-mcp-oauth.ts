import { Effect, Either } from 'effect';
import * as Crypto from 'expo-crypto';
import { remoteMcpSignIn } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { openRemoteMcpAuthorization } from './remote-mcp-oauth-browser';
import { remoteMcpOAuthProvider } from './remote-mcp-oauth-provider';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * A person's sign-in to one OAuth server, in the browser. The provider is the
 * one discovery uses (`remote-mcp-oauth-provider.ts`), given a `state` and a
 * browser, so the code that comes back is the answer to this request only.
 */

/** The authorization code a redirect carries, once it is the answer to this request. */
export function authorizationCodeOf(redirect: string, state: string): string {
  const params = new URL(redirect).searchParams;
  const error = params.get('error');
  if (error !== null) {
    const description = params.get('error_description');
    throw new Error(description === null ? error : `${error}: ${description}`);
  }
  if (params.get('state') !== state) {
    throw new Error('The authorization redirect answered another request.');
  }
  const code = params.get('code');
  if (code === null) {
    throw new Error('The authorization redirect carried no code.');
  }
  return code;
}

export type RemoteMcpSignInOutcome = 'signed-in' | 'turned-back' | 'failed';

/** Signs a person in to one server in the browser, and says how it ended. */
export async function signInRemoteMcpServer(
  server: StoredRemoteMcpServer
): Promise<RemoteMcpSignInOutcome> {
  const state = Crypto.randomUUID();
  const authProvider = remoteMcpOAuthProvider(server, {
    state,
    authorize: async url => {
      const redirect = await openRemoteMcpAuthorization(url.href);
      return redirect === null ? null : authorizationCodeOf(redirect, state);
    },
  });
  const outcome = await Effect.runPromise(
    Effect.either(
      remoteMcpSignIn(
        { id: server.id, name: server.name, url: server.url, auth: { type: 'oauth' } },
        { fetch, authProvider }
      )
    )
  );
  if (Either.isRight(outcome)) {
    return 'signed-in';
  }
  return authProvider.turnedBack() ? 'turned-back' : 'failed';
}
