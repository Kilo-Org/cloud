import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { cleanEgressHeaders } from '@kilocode/worker-utils/egress-http';

function headersOf(request: IncomingMessage) {
  const headers = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    headers.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
  return cleanEgressHeaders(headers);
}
export function sendHttpResponse(
  response: Response,
  outgoing: ServerResponse,
  signal: AbortSignal
) {
  const headers = cleanEgressHeaders(response.headers);
  if (!outgoing.shouldKeepAlive) headers.set('connection', 'close');
  const rawHeaders: string[] = [];
  for (const [key, value] of headers) if (key !== 'set-cookie') rawHeaders.push(key, value);
  for (const value of headers.getSetCookie()) rawHeaders.push('set-cookie', value);
  outgoing.writeHead(response.status, rawHeaders);
  if (!response.body) {
    outgoing.end();
    return;
  }
  const body = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>, { signal });
  body.once('error', () => outgoing.destroy());
  outgoing.once('close', () => body.destroy());
  body.pipe(outgoing);
}

/** Forward origin-form requests without hop-by-hop headers. */
export function incomingRequest(request: IncomingMessage, target: URL, signal: AbortSignal) {
  const options: RequestInit & { duplex: 'half' } = {
    method: request.method,
    headers: headersOf(request),
    redirect: 'manual',
    signal,
    duplex: 'half',
    ...(request.method === 'GET' || request.method === 'HEAD'
      ? {}
      : { body: Readable.toWeb(request) as ReadableStream<Uint8Array> }),
  };
  return new Request(target, options);
}
