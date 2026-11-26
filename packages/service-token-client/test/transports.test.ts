import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MINT_BATCH_WINDOW_MS } from '../src/client';
import { ServiceTokenError } from '../src/errors';
import { createHttpServiceTokens } from '../src/http';
import { createWorkerServiceTokens } from '../src/worker';

const WEB = { audience: 'web', scope: 'web:sts.canary' };

function issued(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued',
      audience,
      scope,
      token: 'header.payload.signature',
      jti: 'jti-1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

async function settle<T>(promise: Promise<T>, ms = MINT_BATCH_WINDOW_MS + 5): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return await promise;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWorkerServiceTokens', () => {
  it('mints through the binding and disposes the RPC result', async () => {
    const dispose = vi.fn();
    const mintTokens = vi.fn(async (request: MintRequest) => ({
      ...issued(request),
      [Symbol.dispose]: dispose,
    }));
    const tokens = createWorkerServiceTokens({ mintTokens });

    expect(await settle(tokens.get(WEB))).toBe('header.payload.signature');
    expect(mintTokens).toHaveBeenCalledWith({ tokens: [WEB] });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('createHttpServiceTokens', () => {
  it('posts the mint request with the identity token to /v1/token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    // The client posts a string URL and a JSON string body.
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init ?? {} });
      const request = JSON.parse(init?.body as string) as MintRequest;
      return Response.json(issued(request), { status: 200 });
    });
    const tokens = createHttpServiceTokens({
      stsUrl: 'https://sts.test/',
      getIdentityToken: async () => 'identity-token',
      fetch: fetchFn as typeof fetch,
    });

    expect(await settle(tokens.get(WEB))).toBe('header.payload.signature');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://sts.test/v1/token');
    expect(calls[0].init.method).toBe('POST');
    expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer identity-token');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ tokens: [WEB] });
  });

  it('maps a 401 identity_rejected to a denial', async () => {
    const tokens = createHttpServiceTokens({
      stsUrl: 'https://sts.test',
      getIdentityToken: () => 'identity-token',
      fetch: (async () =>
        Response.json({ status: 'identity_rejected' }, { status: 401 })) as typeof fetch,
    });
    const error = await settle(tokens.get(WEB).catch((caught: unknown) => caught));
    expect(error).toBeInstanceOf(ServiceTokenError);
    expect(error).toMatchObject({ reason: 'denied', deniedReason: 'identity_rejected' });
  });

  it('never follows a redirect: the mint is manual and a 3xx is unavailable', async () => {
    const redirects: (RequestRedirect | undefined)[] = [];
    const tokens = createHttpServiceTokens({
      stsUrl: 'https://sts.test',
      getIdentityToken: () => 'identity-token',
      fetch: (async (_url: string, init?: RequestInit) => {
        redirects.push(init?.redirect);
        // A followed redirect would carry the identity token to the target and answer its body.
        return init?.redirect === 'manual'
          ? new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } })
          : Response.json(issued(JSON.parse(init?.body as string) as MintRequest));
      }) as typeof fetch,
    });
    expect(await settle(tokens.get(WEB).catch((caught: unknown) => caught))).toMatchObject({
      reason: 'unavailable',
    });
    expect(redirects).toEqual(['manual']);
  });

  it('treats a failing identity provider and a status that disagrees with the body as unavailable', async () => {
    const failing = createHttpServiceTokens({
      stsUrl: 'https://sts.test',
      getIdentityToken: async () => {
        throw new Error('no Vercel token for the STS audience: no token before the deadline');
      },
      fetch: (async () => {
        throw new Error('not called');
      }) as typeof fetch,
    });
    expect(await settle(failing.get(WEB).catch((caught: unknown) => caught))).toMatchObject({
      reason: 'unavailable',
    });

    const mismatched = createHttpServiceTokens({
      stsUrl: 'https://sts.test',
      getIdentityToken: () => 'identity-token',
      fetch: (async (_url: string, init?: RequestInit) =>
        Response.json(issued(JSON.parse(init?.body as string) as MintRequest), {
          status: 503,
        })) as typeof fetch,
    });
    expect(await settle(mismatched.get(WEB).catch((caught: unknown) => caught))).toMatchObject({
      reason: 'unavailable',
    });
  });
});
