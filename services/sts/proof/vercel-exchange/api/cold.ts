import { randomUUID } from 'node:crypto';
import { claimSample, exchangeInput, exchangeOnce, refusal } from '../lib/exchange.js';

/** Module scope lives as long as the instance, so it tells instances and cold starts apart. */
const instanceId = randomUUID();
let invocations = 0;

/**
 * One exchange per invocation, the way a cold Vercel instance makes its first STS exchange. The
 * driver (`drive.ts`) fans out invocations to measure the exchange under real instance concurrency.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused !== null) return refused;
  const input = exchangeInput(request);
  if (input instanceof Response) return input;

  invocations += 1;
  const result = await exchangeOnce(input);
  return Response.json(
    {
      instanceId,
      coldStart: invocations === 1,
      status: result.status,
      ms: result.ms,
      errorBody: result.errorBody,
      exchangedClaims:
        invocations === 1 && result.token !== undefined
          ? claimSample(result.token, input.baseToken)
          : undefined,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
