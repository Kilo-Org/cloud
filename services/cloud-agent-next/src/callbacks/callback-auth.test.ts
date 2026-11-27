import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALLBACK_ROUTES, callbackAuth, callbackRouteOf } from './callback-auth.js';
import { deliverCallbackJob } from './delivery.js';
import type { ExecutionCallbackPayload } from './types.js';

const MINTED = 'minted.callback.token';
const BOT_URL = 'https://app.kilo.ai/api/internal/bot-session-callback/bot-1?currentStep=2';
const SECURITY_URL = 'https://app.kilo.ai/api/internal/security-analysis-callback/finding-1';
const REVIEW_URL = 'https://app.kilo.ai/api/internal/code-review-status/review_1';
const WEBHOOK_URL = 'https://hooks.kilosessions.ai/api/callbacks/execution';
const SAA_URL =
  'https://security-auto-analysis.kilosessions.ai/internal/security-analysis-callback/0f0e-1?attempt=a';

const payload: ExecutionCallbackPayload = {
  sessionId: 'session-1',
  cloudAgentSessionId: 'session-1',
  messageId: 'msg_callback',
  status: 'completed',
};

function issue(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued' as const,
      audience,
      scope,
      token: MINTED,
      jti: 'jti-callback',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

function deny(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'denied' as const,
      audience,
      scope,
      reason: 'scope_not_allowed' as const,
    })),
  };
}

/** A fresh binding per case, so no case reads another's held token. */
function mintBinding(answer: (request: MintRequest) => MintResult = issue) {
  return { mintTokens: vi.fn(async (request: MintRequest) => answer(request)) };
}

afterEach(() => vi.unstubAllGlobals());

describe('callbackRouteOf', () => {
  it.each([
    [BOT_URL, 'web:bot-session.callback'],
    [SECURITY_URL, 'web:security-analysis.callback'],
    [REVIEW_URL, 'web:code-review.agent-callback'],
    [WEBHOOK_URL, 'webhook-agent-ingest:execution.callback'],
    [SAA_URL, 'security-auto-analysis:analysis.callback'],
  ])('maps %s to %s', (url, scope) => {
    expect(callbackRouteOf(url)?.scope).toBe(scope);
  });

  it.each([
    'https://example.com/callback',
    'http://app.kilo.ai/api/internal/bot-session-callback/bot-1',
    'https://api.kilo.ai/api/internal/bot-session-callback/bot-1',
    'https://app.kilo.ai.evil.test/api/internal/bot-session-callback/bot-1',
    'https://user:pass@app.kilo.ai/api/internal/bot-session-callback/bot-1',
    'https://app.kilo.ai/api/internal/bot-session-callback/bot-1/extra',
    'https://app.kilo.ai/api/internal/usage/record',
    'https://hooks.kilosessions.ai/api/callbacks/execution/extra',
    'workspace:session-1',
    'not a url',
  ])('maps nothing for %s', url => {
    expect(callbackRouteOf(url)).toBeNull();
  });

  it('keeps every scope under its own audience', () => {
    for (const route of CALLBACK_ROUTES) {
      expect(route.scope.startsWith(`${route.audience}:`)).toBe(true);
    }
  });
});

describe('callbackAuth', () => {
  it('keeps the stored headers of an unlisted target and never mints', async () => {
    const STS = mintBinding();
    const target = { url: 'https://example.com/callback', headers: { Authorization: 'theirs' } };

    expect(await callbackAuth({ STS, CALLBACK_SENDER_AUTH_WEB: 'sts' }, target)).toEqual({
      kind: 'headers',
      headers: { 'Content-Type': 'application/json', Authorization: 'theirs' },
    });
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });

  it('keeps the receiver-issued token under legacy and never mints', async () => {
    const STS = mintBinding();
    const target = { url: BOT_URL, headers: { 'X-Bot-Callback-Token': 'derived' } };

    expect(await callbackAuth({ STS, CALLBACK_SENDER_AUTH_WEB: 'legacy' }, target)).toEqual({
      kind: 'headers',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Callback-Token': 'derived' },
    });
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'sts'])(
    'sends only the STS token to a listed route (switch %j)',
    async CALLBACK_SENDER_AUTH_WEBHOOK_AGENT_INGEST => {
      const STS = mintBinding();
      const target = {
        url: WEBHOOK_URL,
        headers: {
          'X-Callback-Token': 'derived',
          authorization: 'stale',
          'x-webhook-namespace': 'ns',
          'x-webhook-trigger-id': 'trigger',
          'x-webhook-request-id': 'request',
        },
      };

      expect(
        await callbackAuth({ STS, CALLBACK_SENDER_AUTH_WEBHOOK_AGENT_INGEST }, target)
      ).toEqual({
        kind: 'headers',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-namespace': 'ns',
          'x-webhook-trigger-id': 'trigger',
          'x-webhook-request-id': 'request',
          Authorization: `Bearer ${MINTED}`,
        },
      });
      expect(STS.mintTokens).toHaveBeenCalledWith({
        tokens: [
          {
            audience: 'webhook-agent-ingest',
            scope: 'webhook-agent-ingest:execution.callback',
          },
        ],
      });
    }
  );

  it('applies each receiver switch only to its own routes', async () => {
    const STS = mintBinding();
    const env = {
      STS,
      CALLBACK_SENDER_AUTH_WEB: 'legacy',
      CALLBACK_SENDER_AUTH_SECURITY_AUTO_ANALYSIS: 'sts',
    };

    expect(
      await callbackAuth(env, { url: SECURITY_URL, headers: { 'X-Callback-Token': 'derived' } })
    ).toEqual({
      kind: 'headers',
      headers: { 'Content-Type': 'application/json', 'X-Callback-Token': 'derived' },
    });
    expect(
      await callbackAuth(env, { url: SAA_URL, headers: { 'X-Callback-Token': 'derived' } })
    ).toEqual({
      kind: 'headers',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MINTED}` },
    });
    expect(STS.mintTokens).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown switch value for a listed route', async () => {
    const STS = mintBinding();

    expect(
      await callbackAuth({ STS, CALLBACK_SENDER_AUTH_WEB: 'both' }, { url: REVIEW_URL })
    ).toEqual({ kind: 'unavailable', reason: 'invalid_auth' });
    expect(STS.mintTokens).not.toHaveBeenCalled();
  });

  it('reports a missing binding and a denial without a token', async () => {
    expect(await callbackAuth({}, { url: REVIEW_URL })).toEqual({
      kind: 'unavailable',
      reason: 'sts_binding_missing',
    });
    expect(await callbackAuth({ STS: mintBinding(deny) }, { url: REVIEW_URL })).toEqual({
      kind: 'unavailable',
      reason: 'token_denied',
      deniedReason: 'scope_not_allowed',
    });
  });
});

describe('deliverCallbackJob under sts', () => {
  it('posts with the STS token to a listed route', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverCallbackJob(
      { url: BOT_URL, headers: { 'X-Bot-Callback-Token': 'derived' } },
      payload,
      1,
      { env: { STS: mintBinding() }, ctx: { waitUntil: vi.fn() } }
    );

    expect(result).toEqual({ type: 'success' });
    expect(fetchMock).toHaveBeenCalledWith(
      BOT_URL,
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${MINTED}` },
      })
    );
  });

  it('sends nothing and retries when there is no token', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverCallbackJob({ url: REVIEW_URL }, payload, 1, {
      env: { STS: mintBinding(deny) },
    });

    expect(result).toEqual({ type: 'retry', delaySeconds: 60 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
