// Drives the proof-run functions and summarizes them (README.md). Node 24, no dependencies:
//   node drive.ts --mode cold   --url https://<deployment> [--invocations 2500] [--concurrency N]
//   node drive.ts --mode shared --url https://<deployment> [--invocations 2500] [--jitter-ms 500] [--no-claim] [--deadline-ms 20000]
//   node drive.ts --mode warm   --url https://<deployment> [--interval-s 60] [--duration-s 9000]
// Add --dry-run to print the plan and pass rule without calling anything.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import {
  BUDGET_EXCHANGES_PER_WAVE,
  CLAIM_EXCHANGES_PER_REGION,
  DESIGN_PEAK_INSTANCES,
  MIN_DISTINCT_INSTANCES,
  TIME_TO_TOKEN_MAX_MS,
  TIME_TO_TOKEN_P99_MS,
  sharedChecks,
} from './lib/pass-rule.ts';

type Mode = 'cold' | 'shared' | 'warm';
type Json = Record<string, unknown>;
type Invocation = { httpStatus: number | 'network_error'; ms: number; answer: Json | null };

/** The client fails at once on a base token with under 60 seconds left (lib/shared-token.ts). */
const MIN_REMAINING_SECONDS = 60;
/** Salts the shared-cache key so this run never reads an earlier run's entry (same audience). */
const runId = randomUUID();

const { values } = parseArgs({
  options: {
    mode: { type: 'string', default: 'cold' },
    url: { type: 'string' },
    invocations: { type: 'string', default: '2500' },
    concurrency: { type: 'string' },
    'jitter-ms': { type: 'string' },
    'no-claim': { type: 'boolean', default: false },
    'deadline-ms': { type: 'string' },
    'interval-s': { type: 'string', default: '60' },
    'duration-s': { type: 'string', default: '9000' },
    'dry-run': { type: 'boolean', default: false },
  },
});

function positiveInteger(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} takes a positive integer`);
  return value;
}

function isMode(value: string): value is Mode {
  return value === 'cold' || value === 'shared' || value === 'warm';
}

if (!isMode(values.mode)) throw new Error('--mode is cold, shared or warm');
const mode = values.mode;
const invocations = positiveInteger(values.invocations, 'invocations') ?? 2_500;
const concurrency = positiveInteger(values.concurrency, 'concurrency') ?? invocations;
const intervalSeconds = positiveInteger(values['interval-s'], 'interval-s') ?? 60;
const durationSeconds = positiveInteger(values['duration-s'], 'duration-s') ?? 9_000;
const jitterMs = positiveInteger(values['jitter-ms'], 'jitter-ms');
const deadlineMs = positiveInteger(values['deadline-ms'], 'deadline-ms');

function targetFor(base: string): URL {
  const url = new URL(mode === 'shared' ? '/api/shared' : '/api/cold', base);
  if (mode === 'shared') {
    url.searchParams.set('run', runId);
    if (jitterMs !== undefined) url.searchParams.set('jitterMs', String(jitterMs));
    if (deadlineMs !== undefined) url.searchParams.set('deadlineMs', String(deadlineMs));
    if (values['no-claim']) url.searchParams.set('claim', '0');
  }
  return url;
}

const PLANS: Record<Mode, Json> = {
  cold: {
    perInvocation: 'one exchange with a fresh jti, no shared cache',
    invocations,
    concurrency,
    passes:
      'no exchange status 429 or 5xx, no function 5xx, act.aud is the team default and not nested. Proof run 1 failed it (100 served, 2,400 429s); it is the baseline for shared mode.',
  },
  shared: {
    perInvocation:
      'one STS-audience token through the D10 shared Runtime Cache (lib/shared-token.ts)',
    invocations,
    concurrency,
    settings: {
      jitterMs: jitterMs ?? 'default 500',
      claim: !values['no-claim'],
      deadlineMs: deadlineMs ?? 'default 20000',
    },
    passes: `every invocation got a token; no in-memory cache backend; exchange attempts (429s included) <= ${BUDGET_EXCHANGES_PER_WAVE} in total and per region (hard limit); claimHolds: exchange attempts per region (one audience) <= ${CLAIM_EXCHANGES_PER_REGION} and no 429; time-to-token p99 <= ${TIME_TO_TOKEN_P99_MS} ms and max <= ${TIME_TO_TOKEN_MAX_MS} ms; exchanged exp equals the base token exp; act.aud is the team default and not nested; at least ${MIN_DISTINCT_INSTANCES} distinct instances (reported next to the design peak of ${DESIGN_PEAK_INSTANCES})`,
  },
  warm: {
    perInvocation:
      'one exchange, sequentially, to read the header token age on long-lived instances',
    intervalSeconds,
    durationSeconds,
    samples: Math.floor(durationSeconds / intervalSeconds) + 1,
    passes:
      'measurement only: reports the oldest header token, the least time left on it, and how many header tokens had under 60 seconds left (the client fails those at once, with no exchange)',
  },
};

if (values['dry-run']) {
  console.log(
    JSON.stringify(
      {
        mode,
        plan: 'POST with x-proof-key from PROOF_SHARED_SECRET',
        target:
          values.url === undefined ? '<--url required for a real run>' : targetFor(values.url).href,
        ...PLANS[mode],
      },
      null,
      2
    )
  );
  process.exit(0);
}

if (values.url === undefined) throw new Error('--url is required');
const proofKey = process.env.PROOF_SHARED_SECRET;
if (proofKey === undefined || proofKey.length < 32)
  throw new Error('PROOF_SHARED_SECRET is not set');
const target = targetFor(values.url);

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null;
}

function numberField(answer: Json | null, key: string): number | undefined {
  const value = answer?.[key];
  return typeof value === 'number' ? value : undefined;
}

function stringField(answer: Json | null, key: string): string | undefined {
  const value = answer?.[key];
  return typeof value === 'string' ? value : undefined;
}

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

function count(items: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[String(item)] = (counts[String(item)] ?? 0) + 1;
  return counts;
}

function numbers(answers: readonly Json[], key: string): number[] {
  return answers.flatMap(answer => {
    const value = numberField(answer, key);
    return value === undefined ? [] : [value];
  });
}

async function invoke(url: URL): Promise<Invocation> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'x-proof-key': proofKey ?? '' },
      signal: AbortSignal.timeout(90_000),
    });
    const text = await response.text();
    let answer: Json | null;
    try {
      answer = record(JSON.parse(text));
    } catch {
      answer = { errorBody: text.slice(0, 300) };
    }
    return { httpStatus: response.status, ms: performance.now() - started, answer };
  } catch {
    return { httpStatus: 'network_error', ms: performance.now() - started, answer: null };
  }
}

async function fanOut(url: URL): Promise<{ results: Invocation[]; wallMs: number }> {
  const results: Invocation[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, invocations) }, async () => {
      while (next < invocations) {
        next += 1;
        results.push(await invoke(url));
      }
    })
  );
  return { results, wallMs: Math.round(performance.now() - started) };
}

/** The exchanged-claims sample, with the `act` check STS applies. */
function claimsCheck(answers: readonly Json[]) {
  const claims = answers.map(answer => record(answer.exchangedClaims)).find(Boolean) ?? null;
  return {
    exchangedClaims: claims,
    actOk: claims !== null && claims.actAudIsTeamDefault === true && claims.actIsNested === false,
  };
}

/** The rate-limit headers Vercel sent, the first per status, never a token. */
function headerSamples(answers: readonly Json[]) {
  const samples: Record<string, unknown> = {};
  for (const answer of answers) {
    const status = String(answer.status);
    const headers: unknown = Array.isArray(answer.rateLimitHeaders)
      ? answer.rateLimitHeaders[0]
      : answer.rateLimitHeaders;
    if (headers !== undefined && samples[status] === undefined) samples[status] = headers;
  }
  return samples;
}

function common(results: readonly Invocation[], wallMs: number) {
  const answers = results.flatMap(result => (result.answer === null ? [] : [result.answer]));
  const functionFailures = results.filter(
    result => result.httpStatus === 'network_error' || result.httpStatus >= 500
  ).length;
  return {
    answers,
    summary: {
      mode,
      target: target.href,
      invocations,
      concurrency,
      wallMs,
      functionStatuses: count(results.map(result => result.httpStatus)),
      functionLatencyMs: latency(results.map(result => Math.round(result.ms))),
      functionFailures,
      distinctInstances: new Set(answers.map(answer => stringField(answer, 'instanceId'))).size,
      coldStarts: answers.filter(answer => answer.coldStart === true).length,
      regions: count(answers.map(answer => answer.region)),
    },
  };
}

async function runCold(): Promise<Json> {
  const { results, wallMs } = await fanOut(target);
  const { answers, summary } = common(results, wallMs);
  const exchangeStatuses = count(answers.map(answer => answer.status));
  const failedExchanges = Object.keys(exchangeStatuses).filter(
    status => status === '429' || status.startsWith('5') || Number.isNaN(Number(status))
  );
  const { exchangedClaims, actOk } = claimsCheck(answers);
  return {
    ...summary,
    exchangeStatuses,
    exchangeLatencyMs: latency(numbers(answers, 'ms')),
    rateLimitHeaders: headerSamples(answers),
    firstErrors: answers
      .filter(answer => answer.errorBody !== undefined)
      .slice(0, 5)
      .map(answer => ({ status: answer.status, body: answer.errorBody })),
    exchangedClaims,
    actOk,
    passed: failedExchanges.length === 0 && summary.functionFailures === 0 && actOk,
  };
}

async function runShared(): Promise<Json> {
  const { results, wallMs } = await fanOut(target);
  const { answers, summary } = common(results, wallMs);
  const served = answers.filter(answer => answer.status === 'ok').length;
  const sum = (key: string) => numbers(answers, key).reduce((total, value) => total + value, 0);
  const exchangeAttempts = sum('exchangeAttempts');
  const attemptsByRegion: Record<string, number> = {};
  for (const answer of answers) {
    const region = String(answer.region);
    attemptsByRegion[region] =
      (attemptsByRegion[region] ?? 0) + (numberField(answer, 'exchangeAttempts') ?? 0);
  }
  const backends = count(answers.map(answer => answer.cacheBackend));
  const timeToToken = latency(
    answers.flatMap(answer => {
      const ms = numberField(answer, 'timeToTokenMs');
      return answer.status === 'ok' && ms !== undefined ? [ms] : [];
    })
  );
  const { exchangedClaims, actOk } = claimsCheck(answers);
  const expMatchesBase = answers
    .filter(answer => answer.status === 'ok')
    .every(answer => answer.tokenExpMatchesBase === true);
  const checks = sharedChecks({
    invocations,
    served,
    functionFailures: summary.functionFailures,
    inMemoryBackend: backends['in-memory'] !== undefined,
    attemptsByRegion,
    rateLimited: sum('rateLimited'),
    timeToTokenP99: timeToToken.p99,
    timeToTokenMax: timeToToken.max,
    expMatchesBase,
    actOk,
    distinctInstances: summary.distinctInstances,
  });
  return {
    ...summary,
    runId,
    instancesVsDesignPeak: {
      distinctInstances: summary.distinctInstances,
      designPeak: DESIGN_PEAK_INSTANCES,
    },
    served,
    exchanges: answers.filter(answer => answer.source === 'exchanged').length,
    exchangeAttempts,
    rateLimited: sum('rateLimited'),
    attemptsByRegion,
    claimed: answers.filter(answer => answer.claimed === true).length,
    sources: count(answers.map(answer => answer.source)),
    cacheBackends: backends,
    timeToTokenMs: timeToToken,
    waitedMs: latency(numbers(answers, 'waitedMs')),
    cacheReadMsMax: latency(numbers(answers, 'cacheReadMsMax')),
    cacheReads: sum('cacheReads'),
    cacheWrites: sum('cacheWrites'),
    rateLimitHeaders: headerSamples(answers),
    failures: answers
      .filter(answer => answer.status !== 'ok')
      .slice(0, 5)
      .map(answer => ({ status: answer.status, detail: answer.detail ?? answer.errorBody })),
    exchangedClaims,
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

async function runWarm(): Promise<Json> {
  const samples: Json[] = [];
  const started = Date.now();
  for (let index = 0; Date.now() - started <= durationSeconds * 1000; index += 1) {
    const { httpStatus, answer } = await invoke(target);
    const sample = {
      index,
      httpStatus,
      instanceId: stringField(answer, 'instanceId'),
      status: answer?.status,
      nowSeconds: numberField(answer, 'nowSeconds'),
      baseIat: numberField(answer, 'baseIat'),
      baseExp: numberField(answer, 'baseExp'),
      exchangedExp: numberField(answer, 'exchangedExp'),
    };
    samples.push(sample);
    console.error(JSON.stringify(sample));
    const nextAt = started + (index + 1) * intervalSeconds * 1000;
    await sleep(Math.max(0, nextAt - Date.now()));
  }
  const ages: number[] = [];
  const remaining: number[] = [];
  let nearExpiry = 0;
  let instanceSwitches = 0;
  samples.forEach((sample, index) => {
    const now = numberField(sample, 'nowSeconds');
    const iat = numberField(sample, 'baseIat');
    const exp = numberField(sample, 'baseExp');
    if (now !== undefined && iat !== undefined) ages.push(now - iat);
    if (now !== undefined && exp !== undefined) remaining.push(exp - now);
    if (now !== undefined && exp !== undefined && exp - now < MIN_REMAINING_SECONDS) {
      nearExpiry += 1;
    }
    if (index > 0 && sample.instanceId !== samples[index - 1]?.instanceId) instanceSwitches += 1;
  });
  return {
    mode,
    target: target.href,
    samples: samples.length,
    distinctInstances: new Set(samples.map(sample => sample.instanceId)).size,
    instanceSwitches,
    distinctBaseTokens: new Set(samples.map(sample => sample.baseIat)).size,
    headerTokenAgeSeconds: latency(ages),
    headerTokenRemainingSeconds: latency(remaining),
    headerTokensUnder60sLeft: nearExpiry,
    exchangedExpEqualsBaseExp: samples.every(
      sample => sample.exchangedExp === undefined || sample.exchangedExp === sample.baseExp
    ),
    statuses: count(samples.map(sample => sample.status)),
  };
}

const RUNS: Record<Mode, () => Promise<Json>> = { cold: runCold, shared: runShared, warm: runWarm };
console.log(JSON.stringify(await RUNS[mode](), null, 2));
