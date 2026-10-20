import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validatedUpstreamAddresses } from './upstream-url-policy';
import { upstreamDispatcher } from './upstream-connection';

vi.mock('./upstream-url-policy', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  validatedUpstreamAddresses: vi.fn(),
}));

const approved = vi.mocked(validatedUpstreamAddresses);

const hosts: string[] = [];
const openServers: http.Server[] = [];

function listen(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((request, response) => {
    hosts.push(String(request.headers.host));
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('approved');
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function request(hostname: string, port: number) {
  // `dispatcher` is a runtime option of the platform fetch whose type comes
  // from a second copy of the undici types, so the init is asserted here.
  const init = { dispatcher: upstreamDispatcher(), signal: AbortSignal.timeout(5_000) };
  return fetch(`http://${hostname}:${port}/v1/chat/completions`, init as unknown as RequestInit);
}

describe('the upstream dispatcher', () => {
  beforeEach(() => {
    hosts.length = 0;
    approved.mockReset();
  });

  afterEach(async () => {
    await Promise.all(
      openServers.splice(0).map(
        server =>
          new Promise<void>(resolve => {
            server.closeAllConnections();
            server.close(() => resolve());
          })
      )
    );
  });

  it('connects to the approved address and keeps the original Host header', async () => {
    const { server, port } = await listen();
    openServers.push(server);
    approved.mockImplementation(hostname =>
      hostname === 'pinned.example.test' ? ['127.0.0.1'] : null
    );

    const response = await request('pinned.example.test', port);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('approved');
    expect(hosts).toEqual([`pinned.example.test:${port}`]);
    expect(approved).toHaveBeenCalledWith('pinned.example.test');
  });

  it('connects to the approved address for a name the system resolver cannot resolve', async () => {
    const { server, port } = await listen();
    openServers.push(server);
    approved.mockReturnValue(['127.0.0.1']);

    const response = await request('rotation.example.test', port);

    expect(response.status).toBe(200);
    expect(hosts).toEqual([`rotation.example.test:${port}`]);
  });

  it('refuses a hostname no check approved, before opening a connection', async () => {
    const { server, port } = await listen();
    openServers.push(server);

    await expect(request('unapproved.example.test', port)).rejects.toThrow();

    expect(hosts).toEqual([]);
  });
});
