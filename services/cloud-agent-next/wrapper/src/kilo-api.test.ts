import { afterEach, describe, expect, it } from 'bun:test';
import type { KiloClient as SDKClient } from '@kilocode/sdk';
import { createWrapperKiloClient, isKiloServerUnreachableError } from './kilo-api';

describe('isKiloServerUnreachableError', () => {
  it('matches a raw ECONNREFUSED error', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5173'), {
      code: 'ECONNREFUSED',
    });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches a fetch TypeError whose cause carries the network error code', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const error = new Error('fetch failed', { cause });
    expect(isKiloServerUnreachableError(error)).toBe(true);
  });

  it('matches common Bun/undici connection-refused message text without a code', () => {
    expect(
      isKiloServerUnreachableError(new Error('Unable to connect. Is the server running?'))
    ).toBe(true);
    expect(isKiloServerUnreachableError(new Error('fetch failed'))).toBe(true);
  });

  it('matches ECONNRESET and EPIPE', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      )
    ).toBe(true);
    expect(
      isKiloServerUnreachableError(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).toBe(true);
  });

  it('matches Bun fetch connection codes', () => {
    expect(
      isKiloServerUnreachableError(
        Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
          code: 'ConnectionRefused',
        })
      )
    ).toBe(true);
  });

  it('matches a wrapped SDK transport failure through its cause', () => {
    const transport = Object.assign(
      new Error('Unable to connect. Is the computer able to access the url?'),
      { code: 'ConnectionRefused' }
    );
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: Unable to connect.', { cause: transport })
      )
    ).toBe(true);
  });

  it('does not match a live-server application error whose body mentions a fetch failure', () => {
    // A live kilo server relaying an upstream failure: the parsed response body
    // (a plain object, not an Error) is attached as cause by the wrapper.
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: upstream fetch failed: provider 502', {
          cause: { message: 'upstream fetch failed: provider 502' },
        })
      )
    ).toBe(false);
  });

  it('never pattern-matches the composed message of an error that carries a cause', () => {
    expect(
      isKiloServerUnreachableError(
        new Error('Command for session ses_123 failed: fetch failed', {
          cause: new Error('application rejected the command'),
        })
      )
    ).toBe(false);
  });

  it('does not match application-level errors from a live server', () => {
    expect(
      isKiloServerUnreachableError(new Error('Session get returned no data for ses_123'))
    ).toBe(false);
    expect(
      isKiloServerUnreachableError(
        new Error('Async prompt for session ses_123 failed: invalid model')
      )
    ).toBe(false);
  });

  it('does not match non-Error values', () => {
    expect(isKiloServerUnreachableError('ECONNREFUSED')).toBe(false);
    expect(isKiloServerUnreachableError(undefined)).toBe(false);
    expect(isKiloServerUnreachableError(null)).toBe(false);
  });
});

describe('createWrapperKiloClient().answerPermission', () => {
  type RecordedRequest = {
    method: string;
    pathname: string;
    body: Record<string, unknown>;
  };

  const startedServers: ReturnType<typeof Bun.serve>[] = [];

  afterEach(async () => {
    await Promise.all(startedServers.splice(0).map(server => server.stop()));
  });

  async function startStub(status: number): Promise<{ url: string; requests: RecordedRequest[] }> {
    const requests: RecordedRequest[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async req => {
        const url = new URL(req.url);
        requests.push({
          method: req.method,
          pathname: url.pathname,
          body: (await req.json()) as Record<string, unknown>,
        });
        return new Response('{}', { status });
      },
    });
    startedServers.push(server);
    // Bun 1.3.14 exposes `server.url` as a URL object; normalize to a string.
    return { url: server.url.toString(), requests };
  }

  function createClient(serverUrl: string) {
    return createWrapperKiloClient({} as SDKClient, serverUrl, '/workspace');
  }

  it('POSTs an interactive reply to /permission/<id>/reply on a trailing-slash URL', async () => {
    const stub = await startStub(200);
    const client = createClient(stub.url);

    const result = await client.answerPermission('perm_1', 'once', undefined, true);
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_1/reply');
    expect(stub.requests[0].body).toEqual({ reply: 'once', interactive: true });
  });

  it('omits interactive and message for the non-interactive auto-approve shape', async () => {
    const stub = await startStub(200);
    const client = createClient(stub.url);

    const result = await client.answerPermission('perm_2', 'always');
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_2/reply');
    expect(stub.requests[0].body).toEqual({ reply: 'always' });
  });

  it('threads the message through an interactive reply on a stripped URL', async () => {
    const stub = await startStub(200);
    const client = createClient(stub.url.replace(/\/+$/, ''));

    const result = await client.answerPermission('perm_3', 'reject', 'continue read-only', true);
    expect(result).toBe(true);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_3/reply');
    expect(stub.requests[0].body).toEqual({
      reply: 'reject',
      message: 'continue read-only',
      interactive: true,
    });
  });

  it('throws on a non-2xx reply', async () => {
    const stub = await startStub(500);
    const client = createClient(stub.url.replace(/\/+$/, ''));

    let caught: Error | undefined;
    try {
      await client.answerPermission('perm_4', 'once', undefined, true);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toMatch(/Permission reply perm_4 failed/);
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0].method).toBe('POST');
    expect(stub.requests[0].pathname).toBe('/permission/perm_4/reply');
  });
});
