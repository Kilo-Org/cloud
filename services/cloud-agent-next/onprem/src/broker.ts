import { serve } from 'bun';
import { readFile } from 'node:fs/promises';
import {
  ON_PREM_KILO_ROUTE_PREFIXES,
  onPremCredentialRequestSchema,
  onPremCredentialResolutionSchema,
  parseCanonicalOnPremUrl,
  type OnPremCredentialRequest,
  type OnPremCredentialResolution,
} from '../../src/shared/onprem-credential-protocol.js';

export type BrokerAllocation = {
  providerRef: string;
  podUid: string;
  hardStopAt: number;
};

export type OnPremBrokerOptions = {
  port?: number;
  hostname?: string;
  tls: { certFile: string; keyFile: string };
  brokerOrigin: string;
  upstreams: Record<keyof typeof ON_PREM_KILO_ROUTE_PREFIXES, string>;
  localFixtureUpstreams?: Partial<Record<'github.com' | 'api.github.com', string>>;
  resolveAllocation(peerIp: string): Promise<BrokerAllocation | null>;
  resolveCredential(
    allocation: BrokerAllocation,
    request: OnPremCredentialRequest
  ): Promise<OnPremCredentialResolution | null>;
};

export type OnPremBroker = {
  port: number;
  stop(): Promise<void>;
  revokeAllocation(providerRef: string): void;
};

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_ACTIVE_REQUESTS = 128;
const AUTHORIZATION_TIMEOUT_MS = 10_000;
const localHttpHosts = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
  'host.lima.internal',
]);
const strippedHeaders = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'forwarded',
  'via',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'x-original-url',
  'x-rewrite-url',
]);

function approvedOrigin(value: string, httpsOnly = false): string {
  const url = parseCanonicalOnPremUrl(value);
  if (
    !url ||
    url.pathname !== '/' ||
    url.search ||
    (url.protocol !== 'https:' && (httpsOnly || !localHttpHosts.has(url.hostname)))
  ) {
    throw new Error('Invalid broker origin configuration');
  }
  return url.origin;
}

function cleanHeaders(source: Headers, additional: Iterable<string> = []): Headers {
  const blocked = new Set([
    ...strippedHeaders,
    ...additional,
    ...(source.get('connection') ?? '').split(',').map(name => name.trim().toLowerCase()),
  ]);
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!blocked.has(name) && !/^(?:x-forwarded-|x-kilo|cf-|x-vercel-|x-envoy-)/.test(name)) {
      headers.set(name, value);
    }
  }
  return headers;
}

function safeResponse(status: number): Response {
  return new Response(status === 200 ? 'ok' : 'Broker request denied', {
    status,
    headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
  });
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Broker request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      () => {
        signal.removeEventListener('abort', abort);
        reject(new Error('Broker authorization unavailable'));
      }
    );
  });
}

function streamResponse(
  body: ReadableStream<Uint8Array>,
  controller: AbortController,
  release: () => void
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let finished = false;
  let abort: () => void;
  const finish = () => {
    finished = true;
    controller.signal.removeEventListener('abort', abort);
    release();
    controller.abort();
  };
  return new ReadableStream<Uint8Array>({
    start(output) {
      abort = () => {
        if (finished) return;
        output.error(new Error('Broker stream cancelled'));
        void reader.cancel().catch(() => undefined);
        finish();
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    },
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (finished) return;
        if (chunk.done) {
          output.close();
          finish();
        } else {
          output.enqueue(chunk.value);
        }
      } catch {
        if (!finished) {
          output.error(new Error('Broker upstream unavailable'));
          finish();
          controller.abort();
        }
      }
    },
    cancel() {
      finish();
      controller.abort();
      return reader.cancel().catch(() => undefined);
    },
  });
}

export async function startOnPremBroker(options: OnPremBrokerOptions): Promise<OnPremBroker> {
  const brokerOrigin = approvedOrigin(options.brokerOrigin, true);
  if (brokerOrigin === 'https://github.com' || brokerOrigin === 'https://api.github.com') {
    throw new Error('Invalid broker origin configuration');
  }
  const port = options.port ?? 8443;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Invalid broker port configuration');
  }
  const routes = Object.entries(ON_PREM_KILO_ROUTE_PREFIXES).map(([name, prefix]) => ({
    prefix,
    origin: approvedOrigin(options.upstreams[name as keyof typeof ON_PREM_KILO_ROUTE_PREFIXES]),
  }));
  const githubOrigins = new Map([
    [
      'https://github.com',
      approvedOrigin(options.localFixtureUpstreams?.['github.com'] ?? 'https://github.com'),
    ],
    [
      'https://api.github.com',
      approvedOrigin(options.localFixtureUpstreams?.['api.github.com'] ?? 'https://api.github.com'),
    ],
  ]);
  const active = new Set<{ controller: AbortController; allocation: BrokerAllocation | null }>();
  let stopped = false;
  let tls: { cert: Buffer; key: Buffer };
  try {
    const [cert, key] = await Promise.all([
      readFile(options.tls.certFile),
      readFile(options.tls.keyFile),
    ]);
    tls = { cert, key };
  } catch {
    throw new Error('Broker TLS configuration unavailable');
  }

  async function forward(request: Request, peerIp: string): Promise<Response> {
    const incoming = parseCanonicalOnPremUrl(request.url);
    if (!incoming || incoming.protocol !== 'https:') return safeResponse(400);
    const host = request.headers.get('host');
    if (!host || approvedOrigin(`https://${host}`, true) !== incoming.origin) {
      return safeResponse(400);
    }
    let headerBytes = 0;
    let headerCount = 0;
    for (const [name, value] of request.headers) {
      headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
      headerCount++;
    }
    if (headerBytes > MAX_HEADER_BYTES || headerCount > 100) return safeResponse(431);
    if (
      incoming.origin === brokerOrigin &&
      (incoming.pathname === '/health' || incoming.pathname === '/healthz') &&
      (request.method === 'GET' || request.method === 'HEAD')
    ) {
      return safeResponse(200);
    }
    if (stopped || active.size >= MAX_ACTIVE_REQUESTS) return safeResponse(503);
    if (request.headers.has('upgrade')) return safeResponse(400);

    let logicalOrigin = incoming.origin;
    let pathname = incoming.pathname;
    let upstreamOrigin = githubOrigins.get(incoming.origin);
    if (incoming.origin === brokerOrigin) {
      const route = routes.find(
        route => pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)
      );
      if (!route) return safeResponse(404);
      logicalOrigin = route.origin;
      upstreamOrigin = route.origin;
      pathname = pathname.slice(route.prefix.length) || '/';
    }
    if (!upstreamOrigin) return safeResponse(403);
    const logicalUrl = new URL(logicalOrigin);
    logicalUrl.pathname = pathname;
    logicalUrl.search = incoming.search;
    const credentialRequest = onPremCredentialRequestSchema.safeParse({
      url: logicalUrl.href,
      method: request.method,
      ...(request.headers.has('authorization')
        ? { authorization: request.headers.get('authorization') }
        : {}),
    });
    if (!credentialRequest.success) return safeResponse(400);
    const upstreamUrl = new URL(upstreamOrigin);
    upstreamUrl.pathname = logicalUrl.pathname;
    upstreamUrl.search = logicalUrl.search;

    const controller = new AbortController();
    const entry = { controller, allocation: null as BrokerAllocation | null };
    active.add(entry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => controller.abort();
    const release = () => {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      active.delete(entry);
    };
    const expireAt = (deadline: number) => {
      clearTimeout(timer);
      timer = setTimeout(abort, Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)));
      timer.unref();
    };
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    expireAt(Date.now() + AUTHORIZATION_TIMEOUT_MS);
    let streaming = false;
    try {
      controller.signal.throwIfAborted();
      entry.allocation = await withAbort(options.resolveAllocation(peerIp), controller.signal);
      const allocation = entry.allocation;
      if (
        !allocation ||
        !allocation.providerRef ||
        !allocation.podUid ||
        !Number.isSafeInteger(allocation.hardStopAt) ||
        allocation.hardStopAt <= Date.now()
      ) {
        return safeResponse(403);
      }
      expireAt(Math.min(allocation.hardStopAt, Date.now() + AUTHORIZATION_TIMEOUT_MS));
      controller.signal.throwIfAborted();
      const result = await withAbort(
        options.resolveCredential(allocation, credentialRequest.data),
        controller.signal
      );
      const resolution = onPremCredentialResolutionSchema.safeParse(result);
      if (!resolution.success) return safeResponse(403);
      const deadline = Math.min(resolution.data.expiresAt, allocation.hardStopAt);
      if (deadline <= Date.now()) return safeResponse(403);
      controller.signal.throwIfAborted();
      expireAt(deadline);
      const headers = cleanHeaders(request.headers);
      for (const [name, value] of Object.entries(resolution.data.headers)) {
        if (name === 'host') {
          if (value !== logicalUrl.host) return safeResponse(403);
        } else {
          headers.set(name, value);
        }
      }
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
        decompress: false,
        tls: { rejectUnauthorized: true },
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        controller.abort();
        void upstream.body?.cancel().catch(() => undefined);
        return safeResponse(502);
      }
      const responseHeaders = cleanHeaders(upstream.headers, Object.keys(resolution.data.headers));
      responseHeaders.set('cache-control', 'no-store');
      if (!upstream.body)
        return new Response(null, { status: upstream.status, headers: responseHeaders });
      const body = streamResponse(upstream.body, controller, release);
      streaming = true;
      return new Response(body, { status: upstream.status, headers: responseHeaders });
    } catch {
      controller.abort();
      return safeResponse(502);
    } finally {
      if (!streaming) {
        release();
        controller.abort();
      }
    }
  }

  try {
    const server = serve({
      hostname: options.hostname ?? '0.0.0.0',
      port,
      tls,
      development: false,
      maxRequestBodySize: 1024 * 1024 * 1024,
      idleTimeout: 60,
      async fetch(request, server) {
        try {
          const peer = server.requestIP(request);
          if (!peer) return safeResponse(403);
          return await forward(request, peer.address);
        } catch {
          return safeResponse(400);
        }
      },
      error: () => safeResponse(502),
    });
    return {
      port: server.port ?? port,
      async stop() {
        stopped = true;
        for (const entry of active) entry.controller.abort();
        await server.stop(true);
      },
      revokeAllocation(providerRef) {
        for (const entry of active) {
          if (!entry.allocation || entry.allocation.providerRef === providerRef) {
            entry.controller.abort();
          }
        }
      },
    };
  } catch {
    throw new Error('Broker TLS listener unavailable');
  }
}
