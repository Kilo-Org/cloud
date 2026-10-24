type Env = Pick<Cloudflare.StagingEnv, 'USAGE_WRITER_URL'>;

export default {
  async fetch(request: Request, env: Env) {
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

    return fetch(env.USAGE_WRITER_URL, {
      method: 'POST',
      headers,
      body: request.body,
      redirect: 'manual',
      // Match the existing client's budget without importing its schema bundle
      // into this otherwise dependency-free relay. A test checks the alignment.
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(160_000)]),
    });
  },
} satisfies ExportedHandler<Env>;
