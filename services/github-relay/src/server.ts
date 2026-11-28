import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RelayRequest } from './relay';

/** Caddy sends the whole request head at once; a GET has no body to wait for. */
const HEADERS_TIMEOUT_MS = 10_000;
/** Longer than the relay's GitHub timeout, so the relay answers first. */
const REQUEST_TIMEOUT_MS = 30_000;

function webHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
  }
  return headers;
}

/** The Node HTTP adapter of a relay handler: Web `Request` fields in, a streamed `Response` out. */
export function createRelayServer(handle: (request: RelayRequest) => Promise<Response>): Server {
  const server = createServer((req, res) => {
    const controller = new AbortController();
    // The caller went away before the answer was written: stop the GitHub call too.
    res.on('close', () => {
      if (!res.writableFinished) controller.abort();
    });
    const length = req.headers['content-length'];
    const hasBody =
      req.headers['transfer-encoding'] !== undefined || (length !== undefined && length !== '0');
    // A body is refused unread; drain it so the socket stays usable.
    req.resume();

    void (async () => {
      let response: Response;
      try {
        response = await handle({
          method: req.method ?? 'GET',
          target: req.url ?? '/',
          headers: webHeaders(req.headers),
          hasBody,
          signal: controller.signal,
        });
      } catch {
        response = Response.json({ error: 'internal_error' }, { status: 500 });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body === null) {
        res.end();
        return;
      }
      await pipeline(Readable.fromWeb(response.body), res);
      // A failed write or a broken stream ends this one response, never the process.
    })().catch(() => res.destroy());
  });
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  return server;
}
