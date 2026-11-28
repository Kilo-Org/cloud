import 'server-only';
import { STS_SECURE_PROXY_FORWARD, type StsEnvironment } from '@kilocode/sts-contracts';
import {
  stsServiceTokenIfHeld,
  stsTokenFailure,
  type StsTokenFailure,
} from '@kilocode/web-shared/lib/sts-service-tokens';

/**
 * The STS side of `SECURE_PROXY_SENDER_AUTH=sts`. `secure-proxy-sender.ts` imports this module only
 * for an STS send, so a `legacy` deployment never loads it.
 */

export type SecureProxyTokenRead =
  | { kind: 'token'; token: string }
  | { kind: 'not_held' }
  | { kind: 'failed'; failure: StsTokenFailure };

/**
 * The `ai-gateway-secure-proxy:request.forward` token if the process holds one. Never waits for a
 * mint: the read that starts one runs under the invocation's `waitUntil`.
 */
export async function secureProxyToken(environment: StsEnvironment): Promise<SecureProxyTokenRead> {
  try {
    const read = await stsServiceTokenIfHeld(environment, STS_SECURE_PROXY_FORWARD);
    return read.kind === 'failed' ? { kind: 'failed', failure: stsTokenFailure(read.error) } : read;
  } catch (error) {
    return { kind: 'failed', failure: stsTokenFailure(error) };
  }
}
