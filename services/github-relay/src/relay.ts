import type { StsEnvironment } from '@kilocode/sts-contracts';
import { failureResponse, type Verifier } from '@kilocode/verify';
import { CALLERS, matchTarget, type Caller } from './callers';

/**
 * The relay (README): checks the caller's STS token and its path allow-list, then forwards the GET
 * to api.github.com with the caller's own GitHub `Authorization`, and streams the answer back. It
 * holds no GitHub credential and stores no token.
 */

export const GITHUB_ORIGIN = 'https://api.github.com';
/** Carries the caller's STS service token; `Authorization` carries its GitHub token. */
export const RELAY_AUTHORIZATION_HEADER = 'kilo-relay-authorization';
/** Under the migration proxy's 30 s per GitHub call. */
export const UPSTREAM_TIMEOUT_MS = 25_000;
/** An e2-micro holds this many open GitHub calls comfortably; more waits for a retry. */
export const MAX_IN_FLIGHT = 32;
const BUSY_RETRY_AFTER_SECONDS = 1;

/** Request headers that reach GitHub. The relay sets its own `User-Agent`. */
const FORWARDED_REQUEST_HEADERS = ['authorization', 'accept', 'x-github-api-version'];
/** Response headers that reach the caller; never `set-cookie`, `location` or encodings. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'etag',
  'last-modified',
  'link',
  'retry-after',
  'x-github-request-id',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-ratelimit-used',
];

export type RelayRequest = {
  method: string;
  /** The request target as received, such as `/migration-proxy/repos/...?per_page=1`. */
  target: string;
  headers: Headers;
  hasBody: boolean;
  /** Aborts the GitHub call when the caller goes away. */
  signal: AbortSignal;
};

/** One line per request: never a path parameter, query, header, token or body. */
export type RelayLog = {
  method: string;
  route: string | null;
  caller: string | null;
  environment: StsEnvironment | null;
  status: number;
  reason: string | null;
  ms: number;
};

export type StsVerifier = {
  issuer: string;
  environment: StsEnvironment;
  verifier: Verifier<false>;
};

export type RelayDeps = {
  /** One per STS environment the relay serves; the first answers tokens of no known issuer. */
  verifiers: readonly StsVerifier[];
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  log: (line: RelayLog) => void;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  callers?: readonly Caller[];
  maxInFlight?: number;
  timeoutMs?: number;
};

/** The unverified `iss` of a bearer JWT, only to pick the verifier, which checks it again. */
export function bearerIssuer(authorization: string | null): string | null {
  const token = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]*$/.exec(
    authorization ?? ''
  );
  if (token === null) return null;
  try {
    // atob is forgiving-base64: padding is optional.
    const payload: unknown = JSON.parse(atob(token[2].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload !== 'object' || payload === null) return null;
    const iss: unknown = Reflect.get(payload, 'iss');
    return typeof iss === 'string' ? iss : null;
  } catch {
    return null;
  }
}

function refusal(status: number, error: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

export function createRelay(deps: RelayDeps): (request: RelayRequest) => Promise<Response> {
  if (deps.verifiers.length === 0) throw new Error('the relay needs at least one STS verifier');
  const now = deps.now ?? Date.now;
  const callers = deps.callers ?? CALLERS;
  const maxInFlight = deps.maxInFlight ?? MAX_IN_FLIGHT;
  const timeoutMs = deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const waitUntil = deps.waitUntil;
  let inFlight = 0;

  return async request => {
    const started = now();
    const line: RelayLog = {
      method: request.method,
      route: null,
      caller: null,
      environment: null,
      status: 0,
      reason: null,
      ms: 0,
    };
    const finish = (response: Response, reason: string | null = null): Response => {
      line.status = response.status;
      line.reason = reason;
      line.ms = now() - started;
      deps.log(line);
      return response;
    };

    if (request.method === 'GET' && request.target === '/healthz') {
      return new Response('ok\n', { headers: { 'cache-control': 'no-store' } });
    }

    let target: URL;
    try {
      target = new URL(request.target, 'http://relay.invalid');
    } catch {
      return finish(refusal(400, 'invalid_request'), 'invalid_target');
    }
    const match = matchTarget(target, callers);
    // 403, never 404: the proxy reads a GitHub 404 as "no such commit or path".
    if (!match.ok) return finish(refusal(403, 'not_allowed'), match.reason);
    line.route = match.route.name;

    const authorization = request.headers.get(RELAY_AUTHORIZATION_HEADER);
    const issuer = bearerIssuer(authorization);
    const sts = deps.verifiers.find(entry => entry.issuer === issuer) ?? deps.verifiers[0];
    const verified = await sts.verifier.verify(
      authorization,
      { issuer: 'sts', scope: match.caller.scope },
      { waitUntil }
    );
    if (!verified.ok) return finish(failureResponse(verified), verified.reason);
    if (verified.caller.kind !== 'service' || verified.caller.workload !== match.caller.workload) {
      return finish(refusal(403, 'caller_not_allowed'), 'caller_not_allowed');
    }
    line.caller = verified.caller.workload;
    line.environment = sts.environment;

    if (request.method !== 'GET') {
      return finish(refusal(405, 'method_not_allowed', { allow: 'GET' }), 'method_not_allowed');
    }
    if (request.hasBody) return finish(refusal(400, 'invalid_request'), 'body_not_allowed');
    // The relay never calls GitHub from the allowed address without the caller's own credential.
    if (request.headers.get('authorization') === null) {
      return finish(refusal(400, 'invalid_request'), 'github_authorization_missing');
    }
    if (inFlight >= maxInFlight) {
      return finish(
        refusal(503, 'busy', { 'retry-after': String(BUSY_RETRY_AFTER_SECONDS) }),
        'busy'
      );
    }

    const headers = new Headers({ 'user-agent': `kilo-github-relay (${match.caller.workload})` });
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    inFlight += 1;
    let upstream: Response;
    try {
      upstream = await deps.fetch(`${GITHUB_ORIGIN}${match.upstreamPath}`, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      inFlight -= 1;
      return finish(refusal(502, 'upstream_unavailable'), 'upstream_unavailable');
    }

    const answer = new Headers({ 'cache-control': 'no-store' });
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) answer.set(name, value);
    }
    // The slot frees when the body has been read to its end, failed, or been cancelled.
    const body = upstream.body;
    if (body === null || [204, 205, 304].includes(upstream.status)) {
      inFlight -= 1;
      if (body !== null) waitUntil(body.cancel().catch(() => undefined));
      return finish(new Response(null, { status: upstream.status, headers: answer }));
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      inFlight -= 1;
    };
    const reader = body.getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            release();
            controller.close();
          } else {
            // Node types a fetch body's chunks as `any`; they are always bytes.
            controller.enqueue(chunk.value as Uint8Array);
          }
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        release();
        await reader.cancel(reason);
      },
    });
    return finish(new Response(stream, { status: upstream.status, headers: answer }));
  };
}
