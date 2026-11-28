import { EVENT_SERVICE_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  findKiloUserPepper,
  type GetKiloUserPepper,
  type KiloUserPepperResult,
  verifyKiloBearerAgainstCurrentPepper,
} from '@kilocode/worker-utils/kilo-token-auth';
import {
  createUtsUserGate,
  type UtsFeedBinding,
  type UtsUserGate,
} from '@kilocode/worker-uts-auth';
import type { SecretsExecutionContext } from '@kilocode/secrets-client';
import { readEventServiceSecret, type EventServiceSecretsEnv } from './secrets';

export type AuthResult = { userId: string };
export type AuthEnv = Pick<Env, 'WORKER_ENV'> &
  EventServiceSecretsEnv & {
    HYPERDRIVE: Pick<Env['HYPERDRIVE'], 'connectionString'>;
  };
export type AuthenticateTokenOptions = {
  getUserPepper?: GetKiloUserPepper;
  /** The invocation's context, so a bundle revalidation runs under its `waitUntil`. */
  ctx?: SecretsExecutionContext;
};

/** Seconds a client waits before it retries while the account check cannot answer. */
const ACCOUNT_CHECK_RETRY_AFTER_SECONDS = 5;

/**
 * The UTS contract of `POST /connect-ticket`: the ticket opens the caller's own event stream, so a
 * token bound to an organization or acting for someone else is refused.
 */
export const eventServiceUserGate = createUtsUserGate({
  audience: EVENT_SERVICE_AUDIENCE,
  routes: {
    connectTicket: {
      scope: 'event-service:events.subscribe',
      requiresSession: true,
      org: 'forbidden',
    },
  },
});

/** The legacy bearer: a Kilo JWT checked against the account's current pepper. */
export async function authenticateToken(
  token: string | null,
  env: AuthEnv,
  options: AuthenticateTokenOptions = {}
): Promise<AuthResult | null> {
  return verifyKiloBearerAgainstCurrentPepper({
    token,
    // A lazy binding, not an eager read: the verifier caches the resolved value by name for the
    // isolate, so one read serves every later request whichever source `SECRETS_SOURCE` selects.
    nextAuthSecret: { get: () => readEventServiceSecret(env, 'NEXTAUTH_SECRET', options.ctx) },
    workerEnv: env.WORKER_ENV,
    connectionString: env.HYPERDRIVE.connectionString,
    resourceAudience: { audience: EVENT_SERVICE_AUDIENCE, mode: 'allow-legacy' },
    ...(options.getUserPepper ? { getUserPepper: options.getUserPepper } : {}),
  });
}

export type BearerAuthEnv = AuthEnv & {
  USER_BEARER_ACCEPT?: string;
  UTS_FEED?: UtsFeedBinding;
};

export type BearerAuthResult =
  | { outcome: 'user'; userId: string }
  | { outcome: 'unauthorized' }
  /** A UTS answer to send as is: 401/403 with the challenge, 503 with Retry-After, or 500. */
  | { outcome: 'refused'; response: Response };

/**
 * The bearer of `POST /connect-ticket`, by `USER_BEARER_ACCEPT` (default `legacy-only`): the legacy
 * Kilo JWT, or a UTS access token for `event-service:events.subscribe` whose account still exists
 * and is not blocked. A legacy failure stays `unauthorized` and a legacy dependency failure still
 * throws, as before.
 */
export async function authenticateBearer(
  token: string | null,
  env: BearerAuthEnv,
  options: AuthenticateTokenOptions & { gate?: UtsUserGate<'connectTicket'> } = {}
): Promise<BearerAuthResult> {
  const gate = options.gate ?? eventServiceUserGate;
  const { ctx } = options;
  const decision = await gate.decide(
    token,
    { mode: env.USER_BEARER_ACCEPT, environment: env.WORKER_ENV, feed: env.UTS_FEED },
    'connectTicket',
    promise => ctx?.waitUntil(promise)
  );
  if (decision.kind === 'refused') return { outcome: 'refused', response: decision.response };
  if (decision.kind === 'legacy') {
    const auth = await authenticateToken(token, env, options);
    return auth ? { outcome: 'user', userId: auth.userId } : { outcome: 'unauthorized' };
  }

  const userId = decision.caller.userId;
  let account: KiloUserPepperResult | null | undefined;
  try {
    account = await (options.getUserPepper ?? findKiloUserPepper)(
      env.HYPERDRIVE.connectionString,
      userId
    );
  } catch {
    return {
      outcome: 'refused',
      response: Response.json(
        { error: 'Account checks are temporarily unavailable' },
        {
          status: 503,
          headers: {
            'cache-control': 'no-store',
            'retry-after': String(ACCOUNT_CHECK_RETRY_AFTER_SECONDS),
          },
        }
      ),
    };
  }
  return account && !account.blocked ? { outcome: 'user', userId } : { outcome: 'unauthorized' };
}
