import { randomUUID } from 'node:crypto';
import { claimSample, exchangeInput, exchangeOnce, refusal, tokenTimes } from '../lib/exchange.js';

/** Module scope lives as long as the instance, so it tells instances and cold starts apart. */
const instanceId = randomUUID();
let invocations = 0;

/**
 * One exchange per invocation, without the shared cache: what a cold instance costs when every
 * instance exchanges for itself. `drive.ts --mode cold` fans it out; `--mode warm` calls it once a
 * minute for hours to see how old the header token gets on a long-lived instance. Every answer
 * carries the base token's `iat` and `exp`, the clock and the exchanged token's `exp`, never a token.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused !== null) return refused;
  const input = exchangeInput(request);
  if (input instanceof Response) return input;

  invocations += 1;
  const { token, ...result } = await exchangeOnce(input);
  return Response.json(
    {
      instanceId,
      coldStart: invocations === 1,
      region: process.env.VERCEL_REGION ?? null,
      ...result,
      ...tokenTimes(input.baseToken, token),
      exchangedClaims:
        invocations === 1 && token !== undefined ? claimSample(token, input.baseToken) : undefined,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
