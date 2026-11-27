import {
  createWorkerServiceTokens,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokens,
  type ServiceTokensExecutionContext,
} from '@kilocode/service-token-client';
import { deriveCallbackToken } from '@kilocode/worker-utils';
import { z } from 'zod';

/**
 * The STS audience and scope of this Worker's own status writes to the web app's
 * `POST /api/internal/code-review-status/{reviewId}` (E4, p4's scope handoff), granted to the
 * `kilo-code-review-worker` workload only. It joins `STS_SCOPE_REGISTRY` in
 * `@kilocode/sts-contracts` with the registry-and-grants change; until then STS refuses it as
 * `unknown_scope`.
 */
export const STATUS_CALLBACK_SCOPE = {
  audience: 'web',
  scope: 'web:code-review.status-callback',
} as const;

/**
 * `CODE_REVIEW_STATUS_CALLBACK_AUTH`, the switch of this Worker's own status writes and their
 * rollback (D59). Each write carries exactly one credential:
 * - absent or `legacy`: the derived `X-Callback-Token`, exactly as before this switch existed;
 * - `sts`: only a `STATUS_CALLBACK_SCOPE` service token minted over the `STS` binding, in
 *   `Authorization: Bearer`. Without a token the write is not sent and fails.
 * Any other value sends nothing. The callback target this Worker hands Cloud Agent Next keeps the
 * derived token: Cloud Agent Next delivers that callback itself, with its own credential.
 */
const StatusCallbackAuthSchema = z.enum(['legacy', 'sts']).default('legacy');

export type StatusCallbackEnv = {
  STS?: MintBinding;
  CODE_REVIEW_STATUS_CALLBACK_AUTH?: string;
  CALLBACK_TOKEN_SECRET: string;
};

/** The derived callback token's scope; the web route checks it per review and attempt. */
const CALLBACK_TOKEN_SCOPE = 'code-review-status-callback';

export async function derivedCallbackHeaders(
  secret: string,
  reviewId: string,
  attemptId: string | undefined
): Promise<{ 'X-Callback-Token': string }> {
  return {
    'X-Callback-Token': await deriveCallbackToken({
      secret,
      scope: CALLBACK_TOKEN_SCOPE,
      resourceParts: [reviewId, attemptId ?? ''],
    }),
  };
}

/** Why a status write had no credential; logged and thrown, never a token or a secret. */
export class StatusCallbackCredentialError extends Error {
  constructor(
    readonly reason:
      | 'invalid_auth'
      | 'sts_binding_missing'
      | ServiceTokenError['reason']
      | 'unexpected_error',
    readonly deniedReason?: ServiceTokenError['deniedReason']
  ) {
    super(`No credential for the code review status write: ${reason}`);
    this.name = 'StatusCallbackCredentialError';
  }
}

/** The token client, one per isolate, keyed by the binding. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}

/**
 * The credential of one of this Worker's own status writes: its headers, and under `sts` a redirect
 * policy that never carries the token to another origin. Throws `StatusCallbackCredentialError`
 * rather than send a write without its credential.
 */
export async function statusCallbackCredential(
  env: StatusCallbackEnv,
  ctx: ServiceTokensExecutionContext,
  reviewId: string,
  attemptId: string | undefined
): Promise<{ headers: Record<string, string>; redirect?: 'error' }> {
  const mode = StatusCallbackAuthSchema.safeParse(env.CODE_REVIEW_STATUS_CALLBACK_AUTH);
  if (!mode.success) throw new StatusCallbackCredentialError('invalid_auth');
  if (mode.data === 'legacy') {
    return {
      headers: await derivedCallbackHeaders(env.CALLBACK_TOKEN_SECRET, reviewId, attemptId),
    };
  }
  if (env.STS === undefined) throw new StatusCallbackCredentialError('sts_binding_missing');
  let token: string;
  try {
    token = await tokensFor(env.STS).get(STATUS_CALLBACK_SCOPE, ctx);
  } catch (error) {
    if (error instanceof ServiceTokenError) {
      throw new StatusCallbackCredentialError(error.reason, error.deniedReason);
    }
    throw new StatusCallbackCredentialError('unexpected_error');
  }
  return { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' };
}
