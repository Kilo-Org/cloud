import {
  boundedInteger,
  claimSample,
  exchangeInput,
  exchangeOnce,
  latencySummary,
  refusal,
  statusCounts,
  type ClaimSample,
  type ExchangeResult,
} from '../lib/exchange.js';

const DEFAULT_EXCHANGES = 2_500;
const MAX_EXCHANGES = 10_000;
const DEFAULT_CONCURRENCY = 50;
const MAX_CONCURRENCY = 1_000;
const ERROR_SAMPLES = 5;

/**
 * Burst from one instance: `?n=` exchanges (default 2,500) with `?c=` in flight at once (default
 * 50), each with its own `jti` and no cache. Answers latency percentiles, status counts, the first
 * error bodies (tokens redacted), the rate-limit headers of the first success and the first
 * failure, and the claims of one exchanged token, never a token. Its latency numbers are the ones
 * to quote; the limit is measured by the fan-out (`drive.ts`), since one instance is not a cold wave.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = refusal(request);
  if (refused !== null) return refused;
  const input = exchangeInput(request);
  if (input instanceof Response) return input;

  const url = new URL(request.url);
  const total = boundedInteger(url.searchParams.get('n'), DEFAULT_EXCHANGES, MAX_EXCHANGES);
  const concurrency = boundedInteger(
    url.searchParams.get('c'),
    DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY
  );

  const results: ExchangeResult[] = [];
  let next = 0;
  let sample: ClaimSample | null = null;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    while (next < total) {
      next += 1;
      const { token, ...result } = await exchangeOnce(input);
      if (sample === null && token !== undefined) sample = claimSample(token, input.baseToken);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const wallMs = Math.round(performance.now() - started);

  const failures = results.filter(result => result.errorBody !== undefined);
  return Response.json(
    {
      exchanges: total,
      concurrency,
      wallMs,
      perSecond: Math.round((total / wallMs) * 1000 * 10) / 10,
      statuses: statusCounts(results),
      latencyMs: latencySummary(results.map(result => result.ms)),
      firstErrors: failures.slice(0, ERROR_SAMPLES).map(({ status, errorBody }) => ({
        status,
        body: errorBody,
      })),
      rateLimitHeaders: {
        firstSuccess: results.find(result => result.status === 200)?.rateLimitHeaders ?? null,
        firstFailure: failures[0]?.rateLimitHeaders ?? null,
      },
      exchangedClaims: sample,
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
