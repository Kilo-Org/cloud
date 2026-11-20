import { Container } from '@cloudflare/containers';
import { withCallerCancellation } from './caller-cancellation';
import { CONTAINER_NOT_REACHED_PREFIX, isContainerNotReachedBody } from './cli-runner';

export class BenchRunnerContainer extends Container<Env> {
  defaultPort = 3000;
  // Only requests into the container renew this timer; the container's own result posts do
  // not. It covers the CLI timeout plus the whole result-delivery schedule in server.mjs.
  sleepAfter = '10m';
  // The CLI resolves every gateway endpoint from KILO_API_URL. Production
  // points at the real gateway; local dev overrides it via .dev.vars so the
  // benchmark runs against the local apps/web instance.
  envVars = { KILO_API_URL: this.env.KILO_CLI_API_URL };

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/admin/destroy') {
      await this.destroy();
      return new Response('destroyed');
    }
    const response = await super.fetch(withCallerCancellation(request));
    if (response.status !== 500) return response;
    const body = await response.text();
    // A request that never reached the server cannot have started a paid call, so it
    // takes the same retryable 503 as a missing instance.
    if (isContainerNotReachedBody(body)) {
      return new Response(`${CONTAINER_NOT_REACHED_PREFIX}${body}`, { status: 503 });
    }
    // text() decoded the body, so the upstream encoding and length no longer describe it.
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
