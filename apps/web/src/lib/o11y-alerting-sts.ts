import 'server-only';
import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import {
  STS_O11Y_ALERTING_READ,
  STS_O11Y_ALERTING_WRITE,
  type StsEnvironment,
} from '@kilocode/sts-contracts';
import {
  stsServiceToken,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `O11Y_ALERTING_SENDER_AUTH=sts`. `o11y-client.ts` imports this module only for an
 * STS request, so a `legacy` deployment never loads the token client or the Vercel OIDC exchange.
 */

export type O11yAlertingMethod = 'GET' | 'PUT' | 'DELETE';

/**
 * The scope each method needs, as `services/o11y/src/alerting/config-routes.ts` guards the
 * alerting routes: every `GET` is `alertingRead`, every `PUT` and `DELETE` is `alertingWrite`.
 */
const SCOPE_OF_METHOD = {
  GET: STS_O11Y_ALERTING_READ,
  PUT: STS_O11Y_ALERTING_WRITE,
  DELETE: STS_O11Y_ALERTING_WRITE,
} as const satisfies Record<O11yAlertingMethod, ServiceTokenRequest>;

export type O11yAlertingToken =
  | { kind: 'token'; token: string }
  | { kind: 'failed'; failure: StsTokenFailure };

/**
 * The token for one alerting request: held, or one mint within the token client's attempt timeout.
 * An admin is waiting on the answer, so it waits for the mint rather than dropping the request.
 */
export async function o11yAlertingToken(
  environment: StsEnvironment,
  method: O11yAlertingMethod
): Promise<O11yAlertingToken> {
  try {
    return { kind: 'token', token: await stsServiceToken(environment, SCOPE_OF_METHOD[method]) };
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
