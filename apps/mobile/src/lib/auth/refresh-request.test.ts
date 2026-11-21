import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendRefreshRequest } from '@/lib/auth/refresh-request';
import { reportNetworkError } from '@/lib/telemetry/network-errors';

// The transport owns the reporting the wrapped global `fetch` used to provide
// for this route, so these cases observe the reporter itself: spy mode keeps
// the real policy and implementation, only making the call countable.
vi.mock('@/lib/telemetry/network-errors', { spy: true });

const reporter = vi.mocked(reportNetworkError);

/**
 * The refresh answer must be readable at the response head, because a 401
 * decides the session on its status and its body only supplies the blocked copy.
 * Both React Native HTTP clients wait for the whole body before resolving, so
 * the transport reads the head from `XMLHttpRequest` instead. This fake drives
 * that object the way the native module does.
 */
class FakeXhr {
  static instances: FakeXhr[] = [];

  readyState = 0;
  status = 0;
  responseText = '';
  onreadystatechange: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  aborted = false;
  sent: { url: string; body: string } | undefined;
  private readonly headers = new Map<string, string>();

  constructor() {
    FakeXhr.instances.push(this);
  }

  open(_method: string, url: string): void {
    this.sent = { url, body: '' };
  }

  // oxlint-disable-next-line class-methods-use-this -- the fake mirrors the XHR API, which is an instance method
  setRequestHeader(): void {
    // The transport sends one fixed header; nothing to record.
  }

  getResponseHeader(name: string): string | null {
    return this.headers.get(name.toLowerCase()) ?? null;
  }

  send(body: string): void {
    if (this.sent) {
      this.sent.body = body;
    }
  }

  abort(): void {
    this.aborted = true;
  }

  /** The native module's `__didReceiveResponse`: status and headers, no body. */
  receiveHead(status: number, headers: Record<string, string> = {}): void {
    this.status = status;
    for (const [name, value] of Object.entries(headers)) {
      this.headers.set(name.toLowerCase(), value);
    }
    this.readyState = 2;
    this.onreadystatechange?.();
  }

  /** The native module's `__didReceiveData` for the whole body. */
  receiveBody(text: string): void {
    this.responseText = text;
    this.readyState = 4;
    this.onreadystatechange?.();
  }

  fail(): void {
    this.onerror?.();
  }
}

const request = () => ({
  url: 'http://localhost/api/auth/native/refresh',
  body: '{"refreshToken":"stored"}',
  signal: new AbortController().signal,
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.instances = [];
  reporter.mockClear();
});

describe('sendRefreshRequest over XMLHttpRequest', () => {
  it('answers at the response head, before the body exists', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    // Nothing resolves until the head arrives...
    const early = await Promise.race([
      answerPromise.then(() => 'answered'),
      Promise.resolve('pending'),
    ]);
    expect(early).toBe('pending');

    // ...and the head alone is enough to know the status.
    xhr?.receiveHead(401, { 'retry-after': '7' });
    const answer = await answerPromise;

    expect(answer.status).toBe(401);
    expect(answer.ok).toBe(false);
    expect(answer.retryAfter).toBe('7');
    expect(xhr?.sent?.body).toBe('{"refreshToken":"stored"}');
  });

  it('gives a stalled body no more than its budget, then abandons the request', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.receiveHead(401);
    const answer = await answerPromise;

    const started = Date.now();
    const text = await answer.text(40);

    expect(text).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
    // The abandoned request is aborted, not left holding the connection.
    expect(xhr?.aborted).toBe(true);
  });

  it('reads a body that does arrive, in full', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.receiveHead(200);
    const answer = await answerPromise;
    expect(answer.ok).toBe(true);

    xhr?.receiveBody('{"token":"new","refreshToken":"pair","expiresIn":3600}');

    await expect(answer.text(1_000)).resolves.toBe(
      '{"token":"new","refreshToken":"pair","expiresIn":3600}'
    );
  });

  it('reads a body that arrives after the caller has already asked for it', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.receiveHead(200);
    const answer = await answerPromise;

    // The read is outstanding while the body is still on the wire, which is the
    // only path a real answer takes; the completion handler has to settle it.
    const pending = answer.text(1_000);
    await Promise.resolve();
    xhr?.receiveBody('{"token":"late"}');

    await expect(pending).resolves.toBe('{"token":"late"}');
    expect(xhr?.aborted).toBe(false);
  });

  it('releases a request whose answer the caller does not need to read', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.receiveHead(429);
    const answer = await answerPromise;
    expect(answer.status).toBe(429);
    expect(xhr?.aborted).toBe(false);

    answer.release();

    // The unread response must not hold the connection after its status was
    // used for the answer.
    expect(xhr?.aborted).toBe(true);
  });

  it('rejects when the request fails before its head', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.fail();

    await expect(answerPromise).rejects.toThrow('refresh request failed');
  });

  it('aborts and rejects when the caller signal aborts before the head', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const controller = new AbortController();
    const answerPromise = sendRefreshRequest({ ...request(), signal: controller.signal });
    const xhr = FakeXhr.instances[0];
    controller.abort();

    await expect(answerPromise).rejects.toThrow('refresh request aborted');
    expect(xhr?.aborted).toBe(true);
  });
});

describe('sendRefreshRequest without XMLHttpRequest', () => {
  it('falls back to fetch so a Node worker still answers', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ error: 'INVALID_REFRESH_TOKEN' }, { status: 401 }));

    const answer = await sendRefreshRequest(request());

    expect(answer.status).toBe(401);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * The wrapped global `fetch` reported this route before the transport moved to
 * `XMLHttpRequest`; the transport keeps that parity itself, because the raw
 * client never passes through the wrapper.
 */
describe('refresh request telemetry', () => {
  it('reports a 500 answer once', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    FakeXhr.instances[0]?.receiveHead(500);
    await answerPromise;

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'fetch',
        url: 'http://localhost/api/auth/native/refresh',
        method: 'POST',
        status: 500,
        durationMs: expect.any(Number),
      })
    );
  });

  it('reports nothing for a 401 answer', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    FakeXhr.instances[0]?.receiveHead(401);
    await answerPromise;

    // 401 is the app's own answer: it names the blocked-account copy and signs
    // the session out, so a report would describe no defect.
    expect(reporter).not.toHaveBeenCalled();
  });

  it('reports a pre-head failure as a transport failure and still rejects', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    FakeXhr.instances[0]?.fail();

    await expect(answerPromise).rejects.toThrow('refresh request failed');
    expect(reporter).toHaveBeenCalledTimes(1);
    const context = reporter.mock.lastCall?.[0];
    expect(context).toMatchObject({ source: 'fetch', method: 'POST' });
    // A failure before the head has no status to name, so it is reported as the
    // endpoint's `failed` outcome with the rejection attached.
    expect(context).not.toHaveProperty('status');
    expect(context?.error).toBeInstanceOf(Error);
  });

  it('reports nothing for a 400 the auth layer already files', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    FakeXhr.instances[0]?.receiveHead(400);
    await answerPromise;

    // The auth layer reports a terminal refusal on this route itself
    // (`reportAuthTerminalFailure`), and the wrapped fetch never filed a second
    // event for the same answer. A transport report here would duplicate it.
    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not report a failure after the head a second time', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);

    const answerPromise = sendRefreshRequest(request());
    const xhr = FakeXhr.instances[0];
    xhr?.receiveHead(500);
    await answerPromise;
    expect(reporter).toHaveBeenCalledTimes(1);

    // A body that dies after a reported head is the caller's `text()` answering
    // null, so it must not add a second report for the same exchange.
    xhr?.fail();

    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('reports a 500 answer and a rejection on the fetch route too', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined);
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(new Response('upstream failed', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const answer = await sendRefreshRequest(request());

    expect(answer.status).toBe(500);
    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ status: 500, method: 'POST' }));

    reporter.mockClear();
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    await expect(sendRefreshRequest(request())).rejects.toThrow('network down');
    expect(reporter).toHaveBeenCalledTimes(1);
    const context = reporter.mock.lastCall?.[0];
    expect(context).not.toHaveProperty('status');
    expect(context?.error).toBeInstanceOf(Error);
  });
});
