import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendRefreshRequest } from '@/lib/auth/refresh-request';

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
