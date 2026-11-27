import 'server-only';
import type { ServiceTokenRequest } from '@kilocode/service-token-client';
import {
  stsServiceToken,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';
import type { ServiceSenderStsEnvironment } from './service-sender-auth';

/**
 * The STS side of a `service-sender-auth.ts` switch set to `sts`. Senders import this module only
 * for an STS request, so a `legacy` deployment never loads the token client or the Vercel OIDC
 * exchange.
 */

export type ServiceSenderToken =
  | { kind: 'token'; token: string }
  | { kind: 'failed'; failure: StsTokenFailure };

/**
 * The token for one request: held, or one mint within the token client's attempt timeout. The
 * request waits for it rather than going out without a credential.
 */
export async function serviceSenderToken(
  environment: ServiceSenderStsEnvironment,
  request: ServiceTokenRequest
): Promise<ServiceSenderToken> {
  try {
    return { kind: 'token', token: await stsServiceToken(environment, request) };
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
