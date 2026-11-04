import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import {
  prepareWatchwoodSignup as prepare,
  submitWatchwoodSignup as submit,
} from './watchwood.client';

const enabledContext = {
  enabled: true,
  org_id: 'org-test',
  safety_identifier: 'signup-test',
};

function deferred<T>() {
  return Promise.withResolvers<T>();
}

function tokenResult(token = 'action-token') {
  return { token, expires_at: Math.floor(Date.now() / 1000) + 60 };
}

describe('Watchwood browser signup', () => {
  let cleanup: () => void;
  const fetchMock = jest.fn<typeof fetch>();
  const initialize =
    jest.fn<(options: { org_id: string; safety_identifier: string }) => Promise<unknown>>();
  const getToken = jest.fn<() => Promise<unknown>>();

  function installSdk() {
    Reflect.set(window, 'watchwood', { initialize, getToken });
  }

  function script(): HTMLScriptElement {
    const element = document.getElementById('watchwood-sdk');
    if (!element) throw new Error('SDK script missing');
    return element as HTMLScriptElement;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    const { parseHTML } = createRequire(__filename)('linkedom') as {
      parseHTML: (html: string) => { window: typeof globalThis; document: Document };
    };
    const dom = parseHTML('<html><head></head><body></body></html>');
    const globals = { window: dom.window, document: dom.document, fetch: fetchMock };
    const previous = new Map(
      [...Object.keys(globals), 'watchwood'].map(key => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
      ])
    );
    Object.assign(globalThis, globals);
    Reflect.deleteProperty(window, 'watchwood');
    cleanup = () => {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_input, options) =>
      Response.json(options?.method === 'POST' ? { success: true } : enabledContext)
    );
    initialize.mockReset();
    initialize.mockResolvedValue(undefined);
    getToken.mockReset();
    getToken.mockResolvedValue(tokenResult());
  });

  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });

  it.each([
    { enabled: false },
    { enabled: true, org_id: 'org-test' },
    { enabled: true, org_id: '', safety_identifier: 'signup-test' },
    { enabled: true, org_id: 'org-test', safety_identifier: 123 },
  ])('does not load the SDK for disabled or invalid context %j', async context => {
    fetchMock.mockResolvedValue(Response.json(context));

    await prepare();
    await submit();

    expect(document.head.children).toHaveLength(0);
    expect(getToken).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.every(([, options]) => options?.method !== 'POST')).toBe(true);
  });

  it('continues immediately without another request after the server disables collection', async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ enabled: false }));
    await prepare();
    fetchMock.mockReturnValue(new Promise(() => undefined));
    let completed = false;
    void submit().then(() => {
      completed = true;
    });

    await jest.advanceTimersByTimeAsync(0);

    expect(completed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('collects and submits evidence without Promise.withResolvers support', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
    Reflect.set(Promise, 'withResolvers', undefined);
    try {
      const prepared = prepare().then(
        () => true,
        () => false
      );
      await jest.advanceTimersByTimeAsync(0);
      installSdk();
      script().dispatchEvent(new window.Event('load'));
      expect(await prepared).toBe(true);

      await submit();

      expect(fetchMock.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(Promise, 'withResolvers', descriptor);
      else Reflect.deleteProperty(Promise, 'withResolvers');
    }
  });

  it('skips SDK loading when the server context request fails', async () => {
    fetchMock.mockResolvedValue(Response.json({ enabled: true }, { status: 503 }));

    await expect(prepare()).resolves.toBeUndefined();
    await expect(submit()).resolves.toBeUndefined();

    expect(document.head.children).toHaveLength(0);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('loads the hosted SDK and initializes only with server-provided identity', async () => {
    const preparation = prepare();
    await jest.advanceTimersByTimeAsync(0);
    const sdkScript = script();
    expect(sdkScript.src).toBe(
      'https://cdn.platform.openai.com/deployments/watchwood/watchwood.js'
    );
    expect(sdkScript.async).toBe(true);
    installSdk();
    sdkScript.dispatchEvent(new window.Event('load'));
    await preparation;

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/watchwood', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
    expect(initialize).toHaveBeenCalledWith({
      org_id: enabledContext.org_id,
      safety_identifier: enabledContext.safety_identifier,
    });
    expect(getToken).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refreshes identity and gets a token for each action without retaining an earlier token', async () => {
    installSdk();
    await prepare();
    const renewedContext = { ...enabledContext, safety_identifier: 'renewed-signup' };
    fetchMock.mockImplementation(async (_input, options) =>
      Response.json(options?.method === 'POST' ? { success: true } : renewedContext)
    );
    getToken
      .mockResolvedValueOnce(tokenResult('first-token'))
      .mockResolvedValueOnce(tokenResult('next-token'));

    await submit();
    await submit();

    expect(getToken).toHaveBeenCalledTimes(2);
    expect(initialize.mock.calls).toEqual([
      [{ org_id: enabledContext.org_id, safety_identifier: enabledContext.safety_identifier }],
      [{ org_id: renewedContext.org_id, safety_identifier: renewedContext.safety_identifier }],
      [{ org_id: renewedContext.org_id, safety_identifier: renewedContext.safety_identifier }],
    ]);
    const postedBodies = fetchMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(postedBodies).toEqual([
      { token: 'first-token', safety_identifier: 'renewed-signup' },
      { token: 'next-token', safety_identifier: 'renewed-signup' },
    ]);
  });

  it('fails open when the SDK script is blocked and permits a later load', async () => {
    const first = submit();
    await jest.advanceTimersByTimeAsync(0);
    script().dispatchEvent(new window.Event('error'));
    await first;
    expect(document.getElementById('watchwood-sdk')).toBeNull();

    const second = submit();
    await jest.advanceTimersByTimeAsync(0);
    const sdkScript = script();
    installSdk();
    sdkScript.dispatchEvent(new window.Event('load'));
    await second;

    expect(getToken).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(
      1
    );
  });

  it('releases a stalled script after two seconds and ignores its late load', async () => {
    const submission = submit();
    await jest.advanceTimersByTimeAsync(0);
    const sdkScript = script();
    let completed = false;
    void submission.then(() => {
      completed = true;
    });
    await jest.advanceTimersByTimeAsync(1_999);
    expect(completed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await submission;
    expect(completed).toBe(true);
    expect(document.getElementById('watchwood-sdk')).toBeNull();

    installSdk();
    sdkScript.dispatchEvent(new window.Event('load'));
    await jest.advanceTimersByTimeAsync(0);
    expect(initialize).not.toHaveBeenCalled();
    expect(getToken).not.toHaveBeenCalled();
  });

  it.each(['context', 'body', 'initialize', 'token', 'post'] as const)(
    'bounds a stalled %s stage and never resumes it after the deadline',
    async stage => {
      installSdk();
      const stalled = deferred<unknown>();
      if (stage === 'initialize') initialize.mockReturnValue(stalled.promise);
      if (stage === 'token') getToken.mockReturnValue(stalled.promise);
      fetchMock.mockImplementation(async (_input, options) => {
        if (stage === 'context') return stalled.promise as Promise<Response>;
        if (options?.method === 'POST') {
          if (stage === 'post') return stalled.promise as Promise<Response>;
          return Response.json({ success: true });
        }
        if (stage === 'body') {
          return { ok: true, json: () => stalled.promise } as Response;
        }
        return Response.json(enabledContext);
      });

      const submission = submit();
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(submission).resolves.toBeUndefined();
      const callsAtDeadline = fetchMock.mock.calls.length;
      stalled.resolve(
        stage === 'context' || stage === 'post' ? Response.json(enabledContext) : tokenResult()
      );
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(callsAtDeadline);
      expect(fetchMock.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    }
  );

  it('shares one deadline across context, token collection, and the assessment request', async () => {
    installSdk();
    const context = deferred<Response>();
    const token = deferred<unknown>();
    const post = deferred<Response>();
    fetchMock.mockImplementation((_input, options) =>
      options?.method === 'POST' ? post.promise : context.promise
    );
    getToken.mockReturnValue(token.promise);
    const submission = submit();

    await jest.advanceTimersByTimeAsync(700);
    context.resolve(Response.json(enabledContext));
    await jest.advanceTimersByTimeAsync(600);
    token.resolve(tokenResult());
    await jest.advanceTimersByTimeAsync(700);
    await submission;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not initialize an obsolete mount context after a newer submit starts', async () => {
    installSdk();
    const oldContext = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldContext.promise);
    const preparation = prepare();
    await submit();
    await preparation;
    oldContext.resolve(Response.json({ ...enabledContext, safety_identifier: 'obsolete-signup' }));
    await jest.advanceTimersByTimeAsync(0);

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledWith({
      org_id: enabledContext.org_id,
      safety_identifier: enabledContext.safety_identifier,
    });
  });

  it('does not post an obsolete token after another action supersedes its submission', async () => {
    installSdk();
    const oldToken = deferred<unknown>();
    getToken.mockReturnValueOnce(oldToken.promise).mockResolvedValueOnce(tokenResult('new-token'));
    const obsoleteSubmission = submit();
    await jest.advanceTimersByTimeAsync(0);

    await submit();
    await obsoleteSubmission;
    oldToken.resolve(tokenResult('obsolete-token'));
    await jest.advanceTimersByTimeAsync(0);

    const postedBodies = fetchMock.mock.calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([, options]) => JSON.parse(String(options?.body)));
    expect(postedBodies).toEqual([
      { token: 'new-token', safety_identifier: enabledContext.safety_identifier },
    ]);
  });

  it.each([
    { label: 'empty token', result: { token: '', expires_at: 1 } },
    { label: 'expired token', result: { token: 'expired-token', expires_at: 1 } },
    {
      label: 'invalid expiry',
      result: { token: 'invalid-expiry', expires_at: 'tomorrow' },
    },
    {
      label: 'oversized token',
      result: { token: 'x'.repeat(8193), expires_at: Math.floor(Date.now() / 1000) + 60 },
    },
  ])('submits missing coverage for $label', async ({ result }) => {
    installSdk();
    getToken.mockResolvedValue(result);

    await submit();

    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      token: '',
      safety_identifier: enabledContext.safety_identifier,
    });
  });

  it('contains SDK token failures without exposing error details', async () => {
    installSdk();
    getToken.mockRejectedValue(new Error('private SDK details'));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(submit()).resolves.toBeUndefined();
      expect(log).not.toHaveBeenCalled();
      expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body)).token).toBe('');
    } finally {
      log.mockRestore();
    }
  });

  it.each(['context', 'initialize', 'post'] as const)('contains %s failures', async stage => {
    installSdk();
    if (stage === 'initialize') initialize.mockRejectedValue(new Error('Unavailable'));
    fetchMock.mockImplementation(async (_input, options) => {
      if (stage === 'context' || (stage === 'post' && options?.method === 'POST')) {
        throw new Error('Unavailable');
      }
      return Response.json(enabledContext);
    });

    await expect(submit()).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  });
});
