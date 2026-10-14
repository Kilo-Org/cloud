import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PREVIEW_UPSTREAM_TIMEOUT_MS,
  fetchPreviewPort,
  type PreviewContainerPort,
} from './container-port-fetch.js';

type FakeTcpPort = { fetch: (url: string, request: Request) => Promise<Response> };

function fakeContainer(input: { running?: boolean; tcp?: FakeTcpPort }): PreviewContainerPort & {
  getTcpPort: ReturnType<typeof vi.fn>;
} {
  const getTcpPort = vi.fn(() => input.tcp ?? { fetch: async () => new Response('upstream') });
  return {
    running: input.running ?? true,
    getTcpPort,
  };
}

const request = (headers: Record<string, string> = {}): Request =>
  new Request('http://localhost:5173/page?q=1', { headers });

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchPreviewPort refusals', () => {
  it('refuses a not-running container with a fixed 503 before getTcpPort', async () => {
    const container = fakeContainer({ running: false });
    const response = await fetchPreviewPort(container, 5173, request(), () => false);
    expect(response.status).toBe(503);
    await expect(response.text()).resolves.toBe('The sandbox is not running');
    expect(container.getTcpPort).not.toHaveBeenCalled();
  });

  it('refuses a reserved port with a fixed 403 before getTcpPort', async () => {
    const container = fakeContainer({});
    const response = await fetchPreviewPort(container, 5173, request(), port => port === 5173);
    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe('That port is reserved');
    expect(container.getTcpPort).not.toHaveBeenCalled();
  });

  it('refuses an out-of-range port with a fixed 403 before getTcpPort', async () => {
    const container = fakeContainer({});
    const response = await fetchPreviewPort(container, 80, request(), () => false);
    expect(response.status).toBe(403);
    expect(container.getTcpPort).not.toHaveBeenCalled();
  });
});

describe('fetchPreviewPort upstream', () => {
  it('builds the loopback URL, strips the marker and forwards the response body', async () => {
    const tcpFetch = vi.fn(async (_url: string, _request: Request) => {
      return new Response('hello world', { status: 201, headers: { 'X-App': '1' } });
    });
    const container = fakeContainer({ tcp: { fetch: tcpFetch } });
    const response = await fetchPreviewPort(
      container,
      5173,
      request({ 'x-kilo-preview-port': '5173', 'x-kilo-preview-allocation': 'ref' }),
      () => false
    );
    expect(response.status).toBe(201);
    await expect(response.text()).resolves.toBe('hello world');
    const [url, forwarded] = tcpFetch.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:5173/page?q=1');
    expect(forwarded?.headers.get('x-kilo-preview-port')).toBeNull();
    expect(forwarded?.headers.get('x-kilo-preview-allocation')).toBeNull();
    expect(forwarded?.headers.get('Host')).toBe('localhost:5173');
  });

  it('maps a refused connection to a fixed 502', async () => {
    const container = fakeContainer({
      tcp: {
        fetch: async () => {
          throw new Error('connect ECONNREFUSED 127.0.0.1:5173');
        },
      },
    });
    const response = await fetchPreviewPort(container, 5173, request(), () => false);
    expect(response.status).toBe(502);
    await expect(response.text()).resolves.toBe('Nothing is listening on that port');
  });

  it('maps a time-to-headers abort to a fixed 504', async () => {
    vi.useFakeTimers();
    const container = fakeContainer({
      tcp: {
        fetch: (_url, forwarded) =>
          new Promise<Response>((_resolve, reject) => {
            forwarded.signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          }),
      },
    });
    const pending = fetchPreviewPort(container, 5173, request(), () => false);
    await vi.advanceTimersByTimeAsync(PREVIEW_UPSTREAM_TIMEOUT_MS);
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.text()).resolves.toBe('The server on that port did not respond in time');
  });
});
