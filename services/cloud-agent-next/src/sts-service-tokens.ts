import {
  createWorkerServiceTokens,
  ServiceTokenError,
  type MintBinding,
  type ServiceTokenRequest,
  type ServiceTokens,
  type ServiceTokensExecutionContext,
} from '@kilocode/service-token-client';
import { z } from 'zod';

/**
 * The credential switch of each outbound edge that moves from a shared secret to an STS service
 * token (design 6.5, decision D59). The exact lowercase values are `sts` and `legacy`:
 * - unset, empty or `sts`: only an STS token for the receiver's audience and the edge's scope, in
 *   `Authorization: Bearer`, minted over the `STS` binding and sent only to the receiver's
 *   production origin; never the shared credential, and no return to it without a token;
 * - `legacy`: the shared credential the edge sent before its switch existed.
 * Any other value sends nothing. A receiver accepts STS before its senders run on `sts`; rollback
 * is the switch back to `legacy`.
 */
export const SenderAuthSchema = z.preprocess(
  value => (value === '' ? undefined : value),
  z.enum(['legacy', 'sts']).default('sts')
);

export type SenderAuth = z.infer<typeof SenderAuthSchema>;

/** The switch's mode, or `null` for a value that sends nothing. */
export function senderAuth(value: string | undefined): SenderAuth | null {
  const parsed = SenderAuthSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type StsTokenUnavailableReason =
  | 'sts_binding_missing'
  | 'token_unavailable'
  | 'token_denied';

export type StsTokenRead =
  | { kind: 'token'; token: string }
  | {
      kind: 'unavailable';
      reason: StsTokenUnavailableReason;
      deniedReason?: ServiceTokenError['deniedReason'];
    };

/** One token client per binding, so every sender of the isolate shares its held tokens. */
let tokens: { binding: MintBinding; client: ServiceTokens } | null = null;

function tokensFor(binding: MintBinding): ServiceTokens {
  if (tokens?.binding !== binding) tokens = { binding, client: createWorkerServiceTokens(binding) };
  return tokens.client;
}

/**
 * The token for `request`: held, or one mint over the binding within the client's attempt timeout
 * and backoff. Never throws and never carries a token in its failure.
 */
export async function readStsToken(
  binding: MintBinding | undefined,
  request: ServiceTokenRequest,
  ctx?: ServiceTokensExecutionContext
): Promise<StsTokenRead> {
  if (binding === undefined) return { kind: 'unavailable', reason: 'sts_binding_missing' };
  try {
    return { kind: 'token', token: await tokensFor(binding).get(request, ctx) };
  } catch (error) {
    if (error instanceof ServiceTokenError && error.reason === 'denied') {
      return { kind: 'unavailable', reason: 'token_denied', deniedReason: error.deniedReason };
    }
    return { kind: 'unavailable', reason: 'token_unavailable' };
  }
}
