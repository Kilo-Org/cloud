import {
  SECURE_PROXY_BODY_KEY,
  SecureProxyRequestBodySchema,
} from '@kilocode/ai-gateway-secure-proxy-contracts';
import { NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';

function getOutputHeaders(response: Response) {
  const outputHeaders = new Headers();

  for (const headerKey of ['date', 'content-type', 'request-id']) {
    const value = response.headers.get(headerKey);
    if (value) outputHeaders.set(headerKey, value);
  }
  // Vercel modifies encoding/compression, which breaks streamed responses.
  outputHeaders.set('Content-Encoding', 'identity');

  return outputHeaders;
}

function wrapInSafeNextResponse(response: Response) {
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getOutputHeaders(response),
  });
}

function errorResponse(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function isRedirect(response: Response) {
  return response.status >= 300 && response.status < 400;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest();
}

// timingSafeEqual requires equal-length inputs; hashing first avoids an early length check that leaks the secret's length.
function isAuthorized(request: Request, secret: string) {
  const authorization = request.headers.get('authorization') ?? '';
  return timingSafeEqual(sha256(authorization), sha256(`Bearer ${secret}`));
}

function describeFetchError(error: unknown) {
  const cause = error instanceof Error ? error.cause : undefined;
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    causeName: cause instanceof Error ? cause.name : undefined,
    causeCode:
      typeof cause === 'object' && cause !== null && 'code' in cause
        ? String(cause.code)
        : undefined,
  };
}

// Upstream URLs, headers, and error messages can carry credentials, so logs name only the host.
export async function handleSecureProxyRequest(request: Request): Promise<Response> {
  const secret = process.env.KILO_AI_GATEWAY_SECURE_PROXY_SECRET;
  if (!secret) {
    console.error('[secure-proxy] KILO_AI_GATEWAY_SECURE_PROXY_SECRET is not configured');
    return errorResponse(500, 'Secure proxy secret is not configured');
  }
  if (!isAuthorized(request, secret)) {
    console.warn('[secure-proxy] Rejected request with missing or invalid authorization');
    return errorResponse(401, 'Unauthorized');
  }

  const parsed = SecureProxyRequestBodySchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!parsed.success) {
    console.warn('[secure-proxy] Rejected invalid request body', {
      issues: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })),
    });
    return errorResponse(400, 'Invalid secure proxy request');
  }
  const { [SECURE_PROXY_BODY_KEY]: config, ...body } = parsed.data;
  const upstreamHost = new URL(config.url).host;

  let headers: Headers;
  try {
    headers = new Headers(config.headers);
  } catch {
    console.warn('[secure-proxy] Rejected invalid upstream headers', {
      upstreamHost,
      headerNames: Object.keys(config.headers),
    });
    return errorResponse(400, 'Invalid secure proxy headers');
  }
  headers.set('Content-Type', 'application/json');

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // Following a redirect would resend the upstream credentials to a host the config did not name.
      redirect: 'manual',
      signal: request.signal,
    });
  } catch (error) {
    const details = { upstreamHost, ...describeFetchError(error) };
    if (request.signal.aborted) {
      console.warn('[secure-proxy] Client disconnected before upstream responded', details);
    } else {
      console.error('[secure-proxy] Upstream request failed', details);
    }
    return errorResponse(502, 'Upstream request failed');
  }
  const headersAfterMs = Math.round(performance.now() - startedAt);

  if (isRedirect(response)) {
    await response.body?.cancel();
    console.error('[secure-proxy] Upstream responded with a redirect', {
      upstreamHost,
      status: response.status,
    });
    return errorResponse(
      502,
      `Upstream responded with a redirect (HTTP ${response.status}), which the secure proxy does not follow`
    );
  }

  const logUpstreamResponse = response.ok ? console.log : console.warn;
  logUpstreamResponse('[secure-proxy] Upstream responded', {
    upstreamHost,
    status: response.status,
    headersAfterMs,
  });

  return wrapInSafeNextResponse(response);
}
