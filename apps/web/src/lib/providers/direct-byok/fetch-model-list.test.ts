import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchModelListJson } from './fetch-model-list';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const openServers: Array<{ close(): Promise<void> }> = [];

async function startServer(handler: Handler) {
  const server = createServer(handler);
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  openServers.push({ close: () => closeServer(server) });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}` };
}

function closeServer(server: Server) {
  const closed = Promise.withResolvers<void>();
  server.closeAllConnections();
  server.close(error => (error ? closed.reject(error) : closed.resolve()));
  return closed.promise;
}

function sendJson(response: ServerResponse, body: unknown, contentType = 'application/json') {
  response.writeHead(200, { 'content-type': contentType });
  response.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(server => server.close()));
});

describe('fetchModelListJson', () => {
  test('returns the parsed body from the configured origin', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, { data: [{ id: 'provider/model' }] }, 'application/json; charset=utf-8')
    );

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).resolves.toEqual({
      data: [{ id: 'provider/model' }],
    });
  });

  test('accepts a structured JSON media type', async () => {
    const server = await startServer((_request, response) =>
      sendJson(response, { data: [] }, 'application/vnd.api+json')
    );

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).resolves.toEqual({
      data: [],
    });
  });

  test('follows a relative redirect that stays on the configured origin', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(302, { location: '/v1/models-v2' });
        response.end();
        return;
      }
      sendJson(response, { data: [{ id: 'redirected' }] });
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).resolves.toEqual({
      data: [{ id: 'redirected' }],
    });
  });

  test('follows an absolute redirect that stays on the configured origin', async () => {
    const server = await startServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(301, { location: `${server.url}/v2/models` });
        response.end();
        return;
      }
      sendJson(response, { data: [{ id: 'redirected' }] });
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).resolves.toEqual({
      data: [{ id: 'redirected' }],
    });
  });

  test('refuses a redirect to another origin without contacting it', async () => {
    let otherOriginRequests = 0;
    const other = await startServer((_request, response) => {
      otherOriginRequests += 1;
      sendJson(response, { data: [{ id: 'attacker-model' }] });
    });
    const server = await startServer((_request, response) => {
      response.writeHead(302, { location: `${other.url}/v1/models` });
      response.end();
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: request left the configured origin'
    );
    expect(otherOriginRequests).toBe(0);
  });

  test('refuses a redirect without a location', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(302);
      response.end();
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: redirect without a location'
    );
  });

  test('refuses more than three redirect hops', async () => {
    let requests = 0;
    const server = await startServer((request, response) => {
      requests += 1;
      response.writeHead(302, { location: `${request.url}-next` });
      response.end();
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: too many redirects'
    );
    expect(requests).toBe(4);
  });

  test('refuses a response that is not JSON', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html></html>');
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: unexpected content type text/html'
    );
  });

  test('refuses a response without a content type', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200);
      response.end('{"data":[]}');
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: unexpected content type missing'
    );
  });

  test('refuses a declared body that is larger than the limit', async () => {
    const server = await startServer((_request, response) => {
      const body = JSON.stringify({ data: 'x'.repeat(4096) });
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      });
      response.end(body);
    });

    await expect(
      fetchModelListJson(`${server.url}/v1/models`, 'fixture models', { maxBytes: 1024 })
    ).rejects.toThrow('Failed to fetch fixture models: response body is too large');
  });

  test('refuses a streamed body that grows past the limit without a content length', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'transfer-encoding': 'chunked',
      });
      response.write('{"data":["');
      for (let chunk = 0; chunk < 8; chunk++) response.write('x'.repeat(512));
      response.end('"]}');
    });

    await expect(
      fetchModelListJson(`${server.url}/v1/models`, 'fixture models', { maxBytes: 2048 })
    ).rejects.toThrow('Failed to fetch fixture models: response body is too large');
  });

  test('keeps the upstream status message for a failing response', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end();
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: 503 Service Unavailable'
    );
  });

  test('refuses a body that is not valid JSON', async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json');
    });

    await expect(fetchModelListJson(`${server.url}/v1/models`, 'fixture models')).rejects.toThrow(
      'Failed to fetch fixture models: response is not valid JSON'
    );
  });

  test('stops waiting at the deadline', async () => {
    const server = await startServer(() => {
      // Never answers, so only the deadline ends the request.
    });

    await expect(
      fetchModelListJson(`${server.url}/v1/models`, 'fixture models', { timeoutMs: 50 })
    ).rejects.toThrow('Failed to fetch fixture models:');
  });
});
