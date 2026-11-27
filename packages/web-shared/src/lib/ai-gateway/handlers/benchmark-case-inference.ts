import 'server-only';

import {
  BENCHMARK_ADMISSION_HEADER,
  BENCHMARK_MODEL_REQUEST_ID_HEADER,
  BENCHMARK_USAGE_ID_HEADER,
  BenchmarkInferenceApiSchema,
  type BenchmarkGatewayAssignment,
  type BenchmarkInferenceApi,
} from '@kilocode/auto-routing-contracts';
import { NextRequest } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { handleLlmProxyRequest } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy';
import type { BenchmarkCaseContext } from '@kilocode/web-shared/lib/ai-gateway/handlers/llm-proxy';
import {
  benchmarkRefusalResponse,
  verifyBenchmarkAssignment,
} from '@kilocode/web-shared/lib/ai-gateway/benchmark-case-admission';

const API_PATH: Record<BenchmarkInferenceApi, string> = {
  'chat/completions': '/api/v1/chat/completions',
  responses: '/api/v1/responses',
  messages: '/api/v1/messages',
};

function invalid(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'invalid_request', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Stamp the benchmark headers onto the proxy's reply.
 *
 * The proxy can return a response whose headers are immutable (a pass-through of an upstream
 * body), so `headers.set` may throw. Copying into a fresh response is the only safe write; the
 * body stream is passed through untouched so streaming and cancellation still work.
 */
function stampBenchmarkHeaders(
  response: Response,
  assignment: BenchmarkGatewayAssignment,
  admitted: boolean
): Response {
  const headers = new Headers(response.headers);
  headers.set(BENCHMARK_ADMISSION_HEADER, admitted ? 'admitted' : 'refused');
  headers.set(BENCHMARK_USAGE_ID_HEADER, assignment.usageId);
  headers.set(BENCHMARK_MODEL_REQUEST_ID_HEADER, assignment.modelRequestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * The internal request the normal LLM proxy receives for one signed case call.
 *
 * Exported as the seam the handler uses, so the rebuild is unit-testable without the whole
 * proxy chain. It carries the hop's own transport `x-forwarded-for` and nothing else from the
 * inbound request: the proxy derives the client IP from that header only and refuses before
 * any admission work without it, while every identity fact belongs to the signed assignment.
 * The value is forwarded verbatim and never synthesized — with no header the rebuilt request
 * has none, and the proxy's ordinary missing-IP refusal still applies.
 */
export function rebuildBenchmarkProxyRequest(
  api: BenchmarkInferenceApi,
  requestBody: unknown,
  transportForwardedFor: string | null
): NextRequest {
  return new NextRequest(`https://ai-gateway.internal${API_PATH[api]}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(transportForwardedFor === null ? {} : { 'x-forwarded-for': transportForwardedFor }),
    },
    body: JSON.stringify(requestBody),
  });
}

/**
 * The gateway's internal benchmark route.
 *
 * The Worker authenticates with a purpose-separated HMAC over the whole assignment, and this
 * handler rebuilds a normal `/api/v1/<api>` request for the unmodified LLM proxy. The proxy
 * then runs the same authentication, balance, organization policy, provider privacy, guardrail
 * and usage writer paths as any other inference request: a benchmark case is billed through
 * native usage, never through a second accounting mechanism.
 *
 * The assignment reaches the proxy only as an option (never as a header the proxy trusts), so
 * a public caller cannot forge one.
 */
export async function handleBenchmarkCaseInference(request: Request): Promise<Response> {
  let secret: string;
  try {
    secret = await readInternalApiSecret();
  } catch {
    // The secret source is unavailable: a retryable infrastructure refusal, before the body is
    // read or the proxy runs. The error is neither logged nor returned.
    return benchmarkRefusalResponse('admission_unavailable', true);
  }
  if (!secret) {
    return new Response(JSON.stringify({ error: { code: 'not_configured' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }

  const verified = await verifyBenchmarkAssignment(request.headers, secret);
  if (!verified.ok) return verified.response;
  const { assignment } = verified;

  const body = (await request.json().catch(() => null)) as {
    api?: unknown;
    request?: unknown;
  } | null;
  const api = BenchmarkInferenceApiSchema.safeParse(body?.api);
  if (!api.success) return invalid('A benchmark case request needs an api.');
  // The api is signed, so a caller cannot move the case to another API shape.
  if (api.data !== assignment.api) return benchmarkRefusalResponse('payer_unavailable', false);
  if (!body?.request || typeof body.request !== 'object') {
    return invalid('A benchmark case request needs a request body.');
  }

  // The proxy requires a client IP before it does any admission work, and this route is called
  // server-to-server by the benchmark Worker, so the hop's own `x-forwarded-for` is the only
  // transport fact carried into the rebuild. Nothing else from the inbound request is copied,
  // so a caller header cannot influence it — the signed assignment is its only identity.
  const rebuilt = rebuildBenchmarkProxyRequest(
    api.data,
    body.request,
    request.headers.get('x-forwarded-for')
  );

  const benchmark: BenchmarkCaseContext = { assignment, state: { admitted: false } };
  const response = await handleLlmProxyRequest(rebuilt, { benchmark });
  return stampBenchmarkHeaders(response, assignment, benchmark.state.admitted);
}

/** Kept so the route's own auth test and any facade share one comparison. */
export async function internalSecretMatches(presented: string | null): Promise<boolean> {
  // A request without a credential is refused without reading the expected value; a failed read
  // is the same refusal.
  const expected = presented ? await readInternalApiSecret().catch(() => '') : '';
  return Boolean(expected && presented && timingSafeEqual(presented, expected));
}

export { verifyBenchmarkAssignment };
export type { BenchmarkGatewayAssignment };
