import { claimSample, exchangeInput, exchangeOnce, refusal } from '../lib/exchange.js';
import { isDefinitiveRefusal } from '../lib/pass-rule.js';

/** Any audience other than the STS one: the first hop of the chain. */
const INTERMEDIATE_AUDIENCE = 'https://example.invalid';

/**
 * Exchanges the function token for `https://example.invalid`, then exchanges that token again for
 * the run's audience, and answers whether Vercel refused the second hop and the full `act` of each
 * token. STS refuses a token whose `act.aud` is not the team default or whose `act` is nested; this
 * records what Vercel does, never a token.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused !== null) return refused;
  const input = exchangeInput(request);
  if (input instanceof Response) return input;

  const first = await exchangeOnce({ baseToken: input.baseToken, audience: INTERMEDIATE_AUDIENCE });
  if (first.token === undefined) {
    return Response.json(
      { intermediate: { status: first.status, errorBody: first.errorBody }, chained: null },
      { headers: { 'cache-control': 'no-store' } }
    );
  }
  const second = await exchangeOnce({ baseToken: first.token, audience: input.audience });
  return Response.json(
    {
      intermediate: { status: first.status, claims: claimSample(first.token, input.baseToken) },
      chained: {
        status: second.status,
        errorBody: second.errorBody,
        claims: second.token === undefined ? null : claimSample(second.token, input.baseToken),
      },
      // Only a 4xx other than 408 and 429 is Vercel refusing the chain. A 429 is the budget; a 5xx,
      // a timeout, a network error or an unreadable body leaves the question open.
      vercelRefusedChain: isDefinitiveRefusal(second.status),
      chainedRateLimited: second.status === 429,
      chainInconclusive: second.token === undefined && !isDefinitiveRefusal(second.status),
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
