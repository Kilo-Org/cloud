import 'server-only';
import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import {
  createGatewayError,
  GatewayError,
  GatewayErrorCode,
  isIpAddress,
  isPublicIp,
} from '@kilocode/mcp-gateway';

const maxResponseBytes = 1024 * 1024;
const outboundRequestTimeoutMs = 30_000;

export type PublicDestination = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export type GatewayOutboundRequest = (url: string | URL, init?: RequestInit) => Promise<Response>;

export function validatePublicHttpsUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw createGatewayError(GatewayErrorCode.InvalidRequest, 'Invalid URL', 400);
  }
  if (url.protocol !== 'https:') {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must use HTTPS',
      400
    );
  }
  if (url.username || url.password || url.hash) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must not contain credentials or fragment',
      400
    );
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must be publicly reachable',
      400
    );
  }
  if (isIpAddress(hostname) && !isPublicIp(hostname)) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint must be publicly reachable',
      400
    );
  }
  return url;
}

/**
 * Resolves the destination and returns the address the request will connect
 * to. Every A/AAAA answer has to be public.
 */
export async function resolvePublicDestination(value: string | URL): Promise<PublicDestination> {
  const url = validatePublicHttpsUrl(typeof value === 'string' ? value : value.toString());
  const hostname = url.hostname.toLowerCase();
  if (isIpAddress(hostname)) {
    if (!isPublicIp(hostname)) {
      throw createGatewayError(
        GatewayErrorCode.InvalidRequest,
        'Remote endpoint must be publicly reachable',
        400
      );
    }
    const address =
      hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    return { url, address, family: address.includes(':') ? 6 : 4 };
  }
  const [ipv4, ipv6] = await Promise.all([
    resolve4(hostname).catch(() => [] as string[]),
    resolve6(hostname).catch(() => [] as string[]),
  ]);
  const addresses = [...ipv4, ...ipv6];
  if (addresses.length === 0) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint DNS could not be validated',
      400
    );
  }
  if (addresses.some(address => !isPublicIp(address))) {
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint resolves to a non-public destination',
      400
    );
  }
  const useIpv4 = ipv4.length > 0;
  return {
    url,
    address: useIpv4 ? (ipv4[0] as string) : (ipv6[0] as string),
    family: useIpv4 ? 4 : 6,
  };
}

export async function validatePublicHttpsDestination(value: string): Promise<URL> {
  const destination = await resolvePublicDestination(value);
  return destination.url;
}

function bodyToBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Uint8Array) return Buffer.from(body);
  throw new TypeError('Unsupported request body');
}

function responseHeadersToHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    } else if (value !== undefined) {
      result.set(key, value);
    }
  }
  return result;
}

function decodeResponseBody(buffer: Buffer, encoding: string | undefined): Buffer {
  const normalized = encoding?.trim().toLowerCase();
  try {
    switch (normalized) {
      case undefined:
      case '':
      case 'identity':
        return buffer;
      case 'gzip':
      case 'x-gzip':
        return gunzipSync(buffer, { maxOutputLength: maxResponseBytes });
      case 'deflate':
        return inflateSync(buffer, { maxOutputLength: maxResponseBytes });
      case 'br':
        return brotliDecompressSync(buffer, { maxOutputLength: maxResponseBytes });
      default:
        throw createGatewayError(
          GatewayErrorCode.InvalidRequest,
          'Remote endpoint response encoding is not supported',
          400
        );
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw createGatewayError(
      GatewayErrorCode.InvalidRequest,
      'Remote endpoint response could not be decoded',
      400
    );
  }
}

/**
 * Sends the request to the address resolved in this same call. The connection
 * lookup returns that address, so the socket performs no separate resolution.
 */
export async function requestPublicHttps(
  value: string | URL,
  init?: RequestInit
): Promise<Response> {
  const destination = await resolvePublicDestination(value);
  const { url, address, family } = destination;
  const literal = isIpAddress(url.hostname);
  const hostname = literal ? address : url.hostname;
  const body = bodyToBuffer(init?.body);
  const headers = new Headers(init?.headers);
  headers.set('host', url.host);
  if (!headers.has('accept-encoding')) {
    headers.set('accept-encoding', 'gzip, deflate, br');
  }
  if (body && !headers.has('content-length')) {
    headers.set('content-length', String(body.byteLength));
  }

  return await new Promise<Response>((resolve, reject) => {
    const abortError = createGatewayError(
      GatewayErrorCode.TemporarilyUnavailable,
      'Remote endpoint request was aborted',
      504
    );
    const request = httpsRequest(
      {
        hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: Object.fromEntries(headers.entries()),
        family,
        lookup: (_hostname, _options, callback) => callback(null, address, family),
        ...(literal ? {} : { servername: hostname }),
      },
      response => {
        const chunks: Buffer[] = [];
        let responseBytes = 0;
        response.on('data', chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          responseBytes += buffer.byteLength;
          if (responseBytes > maxResponseBytes) {
            const error = createGatewayError(
              GatewayErrorCode.InvalidRequest,
              'Remote endpoint response is too large',
              400
            );
            response.destroy(error);
            request.destroy(error);
            reject(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          const forbidsBody = status === 204 || status === 205 || status === 304;
          const responseHeaders = responseHeadersToHeaders(response.headers);
          const rawEncoding = response.headers['content-encoding'];
          const encoding = Array.isArray(rawEncoding) ? rawEncoding.join(',') : rawEncoding;
          responseHeaders.delete('content-encoding');
          responseHeaders.delete('content-length');
          responseHeaders.delete('transfer-encoding');
          if (forbidsBody) {
            resolve(
              new Response(null, {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders,
              })
            );
            return;
          }
          try {
            resolve(
              new Response(decodeResponseBody(Buffer.concat(chunks), encoding) as BodyInit, {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders,
              })
            );
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.setTimeout(outboundRequestTimeoutMs, () => {
      request.destroy(
        createGatewayError(
          GatewayErrorCode.TemporarilyUnavailable,
          'Remote endpoint request timed out',
          504
        )
      );
    });
    const signal = init?.signal;
    if (signal?.aborted) {
      request.destroy();
      reject(abortError);
      return;
    }
    signal?.addEventListener('abort', () => request.destroy(abortError), { once: true });
    request.on('error', reject);
    request.end(body);
  });
}
