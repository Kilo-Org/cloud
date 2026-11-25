// Fans out concurrent invocations of `api/cold` and summarizes them (README.md).
// Run with Node 24: `node drive.ts --url https://<deployment> [--invocations 2500] [--concurrency 2500]`.
import { parseArgs } from 'node:util';

type ColdAnswer = {
  instanceId?: string;
  coldStart?: boolean;
  status?: number | string;
  ms?: number;
  errorBody?: string;
  exchangedClaims?: unknown;
};

type Invocation = { httpStatus: number | 'network_error'; ms: number; answer: ColdAnswer | null };

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    invocations: { type: 'string', default: '2500' },
    concurrency: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

const invocations = Number(values.invocations);
const concurrency = Number(values.concurrency ?? values.invocations);
if (
  !Number.isInteger(invocations) ||
  invocations < 1 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1
) {
  throw new Error('--invocations and --concurrency take positive integers');
}
const target = values.url === undefined ? null : new URL('/api/cold', values.url);

if (values['dry-run']) {
  console.log(
    JSON.stringify(
      {
        plan: 'POST /api/cold with x-proof-key from PROOF_SHARED_SECRET',
        target: target?.href ?? '<--url required for a real run>',
        invocations,
        concurrency,
        perInvocation: 'one exchange with a fresh jti against https://oidc.vercel.com/~token',
        passes: 'no exchange status 429 or 5xx and no function 5xx; latency percentiles recorded',
      },
      null,
      2
    )
  );
  process.exit(0);
}

const key = process.env.PROOF_SHARED_SECRET;
if (target === null) throw new Error('--url is required');
if (key === undefined || key.length < 32) throw new Error('PROOF_SHARED_SECRET is not set');

function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

function latency(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}

function count(values: readonly (string | number | undefined)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return counts;
}

async function invoke(url: URL, proofKey: string): Promise<Invocation> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-proof-key': proofKey },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let answer: ColdAnswer | null = null;
    try {
      answer = JSON.parse(text) as ColdAnswer;
    } catch {
      answer = { errorBody: text.slice(0, 300) };
    }
    return { httpStatus: response.status, ms: performance.now() - started, answer };
  } catch {
    return { httpStatus: 'network_error', ms: performance.now() - started, answer: null };
  }
}

const results: Invocation[] = [];
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: Math.min(concurrency, invocations) }, async () => {
    while (next < invocations) {
      next += 1;
      results.push(await invoke(target, key));
    }
  })
);
const wallMs = Math.round(performance.now() - started);

const answers = results.flatMap(result => (result.answer === null ? [] : [result.answer]));
const exchangeStatuses = count(answers.map(answer => answer.status));
const failedExchanges = Object.entries(exchangeStatuses).filter(
  ([status]) => status === '429' || status.startsWith('5') || Number.isNaN(Number(status))
);
const functionFailures = results.filter(
  result => result.httpStatus === 'network_error' || result.httpStatus >= 500
);

console.log(
  JSON.stringify(
    {
      invocations,
      concurrency,
      wallMs,
      functionStatuses: count(results.map(result => result.httpStatus)),
      functionLatencyMs: latency(results.map(result => Math.round(result.ms))),
      distinctInstances: new Set(answers.map(answer => answer.instanceId)).size,
      coldStarts: answers.filter(answer => answer.coldStart === true).length,
      exchangeStatuses,
      exchangeLatencyMs: latency(
        answers.flatMap(answer => (typeof answer.ms === 'number' ? [answer.ms] : []))
      ),
      firstErrors: answers
        .filter(answer => answer.errorBody !== undefined)
        .slice(0, 5)
        .map(answer => ({ status: answer.status, body: answer.errorBody })),
      exchangedClaims: answers.find(answer => answer.exchangedClaims !== undefined)
        ?.exchangedClaims,
      passed: failedExchanges.length === 0 && functionFailures.length === 0,
    },
    null,
    2
  )
);
