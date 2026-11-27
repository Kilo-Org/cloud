import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from 'node:https';
import { request as httpRequest, type ClientRequest } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { EgressTransportError, isPublicAddress } from './destination.js';

export type HttpsRequestFactory = (options: HttpsRequestOptions) => ClientRequest;

export type PublicResolver = (hostname: string, signal: AbortSignal) => Promise<readonly string[]>;

/** Connect to a checked address while verifying TLS against the original hostname. Never follows redirects. */
export function fetchAtAddress(
  request: Request,
  address: string,
  createRequest: HttpsRequestFactory = httpsRequest
): Promise<Response> {
  return requestAtAddress(request, address, 'https:', createRequest);
}

export function fetchHttpAtAddress(
  request: Request,
  address: string,
  createRequest: HttpsRequestFactory = httpRequest
): Promise<Response> {
  return requestAtAddress(request, address, 'http:', createRequest);
}

function requestAtAddress(
  request: Request,
  address: string,
  protocol: 'https:' | 'http:',
  createRequest: HttpsRequestFactory
): Promise<Response> {
  const url = new URL(request.url);
  if (
    url.protocol !== protocol ||
    url.port ||
    url.username ||
    url.password ||
    !isPublicAddress(address)
  )
    return Promise.reject(new EgressTransportError('destination_denied'));
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(request.headers);
    headers.host = url.host;
    let upstream: ClientRequest;
    try {
      upstream = createRequest({
        hostname: address,
        port: protocol === 'https:' ? 443 : 80,
        path: url.pathname + url.search,
        method: request.method,
        headers,
        agent: false,
        signal: request.signal,
        maxHeaderSize: 32_768,
        ...(protocol === 'https:' && { servername: url.hostname, minVersion: 'TLSv1.2' }),
      });
    } catch {
      reject(new EgressTransportError('connection_failed'));
      return;
    }
    upstream.once('upgrade', (_response, socket) => {
      clearTimeout(headerDeadline);
      socket.destroy();
      reject(new EgressTransportError('connection_failed'));
    });
    const headerDeadline = setTimeout(() => upstream.destroy(new Error('header deadline')), 15_000);
    upstream.setTimeout(120_000, () => upstream.destroy(new Error('idle deadline')));
    upstream.once('error', () => {
      clearTimeout(headerDeadline);
      reject(new EgressTransportError('connection_failed'));
    });
    upstream.once('response', incoming => {
      clearTimeout(headerDeadline);
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2)
          responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        const status = incoming.statusCode ?? 502;
        const body =
          request.method === 'HEAD' || [204, 205, 304].includes(status)
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
        if (body === null) incoming.resume();
        resolve(new Response(body, { status, headers: responseHeaders }));
      } catch {
        incoming.destroy();
        upstream.destroy();
        reject(new EgressTransportError('connection_failed'));
      }
    });
    if (request.body) {
      const body = Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>);
      body.once('error', () => upstream.destroy(new Error('request body failed')));
      upstream.once('close', () => body.destroy());
      body.pipe(upstream);
    } else upstream.end();
  });
}

/** Every request gets a fresh checked resolution and a socket pinned to that result. */
export function publicHttpsFetch(resolve: PublicResolver) {
  return async (request: Request): Promise<Response> => {
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    const addresses = await resolve(new URL(request.url).hostname, signal);
    if (!addresses.length || addresses.some(address => !isPublicAddress(address)))
      throw new EgressTransportError('destination_denied');
    return fetchAtAddress(request, addresses[0]);
  };
}
