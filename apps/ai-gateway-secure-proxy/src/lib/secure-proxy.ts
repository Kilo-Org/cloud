import {
  SECURE_PROXY_BODY_KEY,
  SecureProxyRequestBodySchema,
} from '@kilocode/ai-gateway-secure-proxy-contracts';
import { NextResponse } from 'next/server';

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

export async function handleSecureProxyRequest(request: Request): Promise<Response> {
  const parsed = SecureProxyRequestBodySchema.safeParse(
    await request.json().catch(() => undefined)
  );
  if (!parsed.success) {
    return errorResponse(400, 'Invalid secure proxy request');
  }
  const { [SECURE_PROXY_BODY_KEY]: config, ...body } = parsed.data;

  let headers: Headers;
  try {
    headers = new Headers(config.headers);
  } catch {
    return errorResponse(400, 'Invalid secure proxy headers');
  }
  headers.set('Content-Type', 'application/json');

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
  } catch {
    return errorResponse(502, 'Upstream request failed');
  }

  if (isRedirect(response)) {
    await response.body?.cancel();
    return errorResponse(
      502,
      `Upstream responded with a redirect (HTTP ${response.status}), which the secure proxy does not follow`
    );
  }

  return wrapInSafeNextResponse(response);
}
