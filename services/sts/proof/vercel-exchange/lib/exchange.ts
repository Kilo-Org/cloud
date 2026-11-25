import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** The custom-audience exchange `@vercel/oidc` calls (packages/oidc/src/exchange-vercel-oidc-token.ts). */
const EXCHANGE_URL = 'https://oidc.vercel.com/~token';
const EXCHANGE_TIMEOUT_MS = 10_000;
const ERROR_BODY_LIMIT = 500;
const JWT_PATTERN = /[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g;
/**
 * The audience when the operator sets none: not an STS issuer, so a token the harness exchanges
 * can never be presented to STS.
 */
const DEFAULT_AUDIENCE = 'https://sts-proof.invalid';
const RATE_LIMIT_HEADER = /^(x-ratelimit-|ratelimit|retry-after$)/;

/** The exchange's rate-limit headers (`x-ratelimit-*`, `ratelimit*`, `retry-after`), by name. */
export type RateLimitHeaders = Record<string, string>;

export type ExchangeResult = {
  status: number | 'network_error' | 'timeout' | 'invalid_body';
  ms: number;
  errorBody?: string;
  rateLimitHeaders?: RateLimitHeaders;
  /** Set on success only; never leaves the function, only its claims sample does. */
  token?: string;
};

/** The claims an exchanged token carries, without the token. */
export type ClaimSample = {
  iss: unknown;
  aud: unknown;
  act: unknown;
  sub: unknown;
  owner: unknown;
  owner_id: unknown;
  project_id: unknown;
  environment: unknown;
  custom_environment_id: unknown;
  /** Whether it tells a build token from a function token decides if STS pins it (README, N5). */
  scope: unknown;
  plan: unknown;
  /** Presence only: the value names the deployment, which the run does not need. */
  deploymentIdPresent: boolean;
  /** `act` is an object whose `aud` is the team default `https://vercel.com/<owner>`. */
  actAudIsTeamDefault: boolean;
  /** `act` carries an `act` of its own: the token was exchanged from an exchanged token. */
  actIsNested: boolean;
  lifetimeSeconds: number | null;
  expMatchesBaseToken: boolean;
  claimNames: string[];
};

/**
 * Refuses a request unless it carries `x-proof-key` equal to `PROOF_SHARED_SECRET`. Without the
 * variable the function refuses everything, so a deployment someone forgot to configure runs nothing.
 */
export function refusal(request: Request): Response | null {
  const expected = process.env.PROOF_SHARED_SECRET;
  if (expected === undefined || expected.length < 32) {
    return Response.json({ error: 'PROOF_SHARED_SECRET is not set' }, { status: 503 });
  }
  const presented = request.headers.get('x-proof-key') ?? '';
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(presented), digest(expected))) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

export type ExchangeInput = { baseToken: string; audience: string };

/** Reads the function's own OIDC token and the audience to exchange it for. */
export function exchangeInput(request: Request): ExchangeInput | Response {
  const baseToken = request.headers.get('x-vercel-oidc-token');
  if (baseToken === null || baseToken === '') {
    return Response.json(
      { error: 'no x-vercel-oidc-token header: enable OIDC federation on the project' },
      { status: 500 }
    );
  }
  return { baseToken, audience: process.env.PROOF_AUDIENCE || DEFAULT_AUDIENCE };
}

function redact(text: string): string {
  return text.slice(0, ERROR_BODY_LIMIT).replace(JWT_PATTERN, '<jwt>');
}

function rateLimitHeaders(headers: Headers): RateLimitHeaders | undefined {
  const found: RateLimitHeaders = {};
  for (const [name, value] of headers) {
    if (RATE_LIMIT_HEADER.test(name)) found[name] = value;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

/** One exchange with a fresh `jti`, so no cache on either side can answer it. */
export async function exchangeOnce(input: ExchangeInput): Promise<ExchangeResult> {
  const started = performance.now();
  const elapsed = () => Math.round((performance.now() - started) * 10) / 10;
  let response: Response;
  try {
    response = await fetch(EXCHANGE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: input.baseToken, aud: input.audience, jti: randomUUID() }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    return { status: timedOut ? 'timeout' : 'network_error', ms: elapsed() };
  }
  const headers = rateLimitHeaders(response.headers);
  const text = await response.text();
  if (!response.ok) {
    return {
      status: response.status,
      ms: elapsed(),
      errorBody: redact(text),
      rateLimitHeaders: headers,
    };
  }
  let token: unknown;
  try {
    const parsed: unknown = JSON.parse(text);
    token =
      typeof parsed === 'object' && parsed !== null && 'token' in parsed ? parsed.token : null;
  } catch {
    token = null;
  }
  if (typeof token !== 'string') {
    return { status: 'invalid_body', ms: elapsed(), errorBody: redact(text) };
  }
  return { status: response.status, ms: elapsed(), rateLimitHeaders: headers, token };
}

/** A JWT's claims, unverified; `{}` when the token is not a JWT. */
export function payloadOf(token: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')
    );
    return typeof parsed === 'object' && parsed !== null ? { ...parsed } : {};
  } catch {
    return {};
  }
}

export function claimSample(exchanged: string, baseToken: string): ClaimSample {
  const claims = payloadOf(exchanged);
  const { exp, iat, act, owner } = claims;
  const actObject = typeof act === 'object' && act !== null && !Array.isArray(act) ? act : null;
  return {
    iss: claims.iss,
    aud: claims.aud,
    act,
    sub: claims.sub,
    owner,
    owner_id: claims.owner_id,
    project_id: claims.project_id,
    environment: claims.environment,
    custom_environment_id: claims.custom_environment_id,
    scope: claims.scope,
    plan: claims.plan,
    deploymentIdPresent: 'deployment_id' in claims,
    actAudIsTeamDefault:
      actObject !== null &&
      typeof owner === 'string' &&
      'aud' in actObject &&
      actObject.aud === `https://vercel.com/${owner}`,
    actIsNested: actObject !== null && 'act' in actObject,
    lifetimeSeconds: typeof exp === 'number' && typeof iat === 'number' ? exp - iat : null,
    expMatchesBaseToken: exp !== undefined && exp === payloadOf(baseToken).exp,
    claimNames: Object.keys(claims).sort(),
  };
}

/** Nearest-rank percentile of an ascending list. */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? null;
}

export function latencySummary(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}

export function statusCounts(results: readonly ExchangeResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

export function boundedInteger(raw: string | null, fallback: number, max: number): number {
  const value = raw === null ? fallback : Number(raw);
  return Number.isInteger(value) && value >= 1 ? Math.min(value, max) : fallback;
}

function numberClaim(token: string, name: string): number | null {
  const value = payloadOf(token)[name];
  return typeof value === 'number' ? value : null;
}

/** The base token's `iat` and `exp` and the clock, so a run shows how old the header token is. */
export function tokenTimes(baseToken: string, exchanged: string | undefined) {
  return {
    nowSeconds: Math.floor(Date.now() / 1000),
    baseIat: numberClaim(baseToken, 'iat'),
    baseExp: numberClaim(baseToken, 'exp'),
    exchangedExp: exchanged === undefined ? null : numberClaim(exchanged, 'exp'),
  };
}
