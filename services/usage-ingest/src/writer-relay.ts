import { logSafely } from './diagnostics';

type Env = Pick<Cloudflare.StagingEnv, 'USAGE_WRITER_URL'> &
  Partial<Pick<Cloudflare.StagingEnv, 'USAGE_INGEST_DIAGNOSTICS'>>;

export default {
  async fetch(request: Request, env: Env) {
    const entryAtMs = Date.now();
    if (new URL(request.url).pathname !== '/api/internal/usage/record') {
      return new Response('Not Found', { status: 404 });
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Only service bindings can reach this Worker. The existing writer still
    // authenticates the forwarded secret; never accept a caller-selected target.
    const headers = new Headers({
      'content-type': 'application/json',
      'x-usage-write-source': 'queue',
    });
    for (const name of ['x-internal-api-key', 'x-vercel-protection-bypass']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    if (!headers.has('x-internal-api-key')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const usageId = request.headers.get('x-usage-id');
    const diagnostic =
      env.USAGE_INGEST_DIAGNOSTICS === 'all' &&
      usageId !== null &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(usageId);
    if (diagnostic) headers.set('x-usage-id', usageId);
    const beforeForwardAtMs = Date.now();
    const startedAt = performance.now();
    let response: Response | undefined;
    try {
      response = await fetch(env.USAGE_WRITER_URL, {
        method: 'POST',
        headers,
        body: request.body,
        redirect: 'manual',
        // Match the existing client's budget without importing its schema bundle
        // into this otherwise dependency-free relay. A test checks the alignment.
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(160_000)]),
      });
      return response;
    } finally {
      if (diagnostic)
        logSafely('info', () => ({
          event: 'usage_ingest_relay_forward',
          usage_id: usageId,
          relay_entry_at_ms: entryAtMs,
          before_forward_at_ms: beforeForwardAtMs,
          after_forward_at_ms: Date.now(),
          forward_duration_ms: Math.round(performance.now() - startedAt),
          outcome: response ? 'response' : 'request_failed',
          ...(response ? { writer_status: response.status } : {}),
        }));
    }
  },
} satisfies ExportedHandler<Env>;
