import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedClassifierInput, RoutingContext } from '@kilocode/auto-routing-contracts';
import {
  MORPH_ROUTER_ENDPOINT,
  MorphRouterError,
  buildRouterInput,
  clearMorphApiKeyCache,
  routeWithMorphRouter,
  routerConfigFingerprint,
} from './morph-router';

const originalFetch = globalThis.fetch;
const mockedFetch = vi.fn<typeof globalThis.fetch>();
const apiKeyGet = vi.fn(async () => 'morph-key');

const env = { MORPH_API_KEY: { get: apiKeyGet } } as unknown as Pick<Env, 'MORPH_API_KEY'>;

const normalizedInput: NormalizedClassifierInput = {
  apiKind: 'chat_completions',
  requestedModel: 'kilo-auto/frontier',
  systemPromptPrefix: 'You are Kilo Code.',
  userPromptPrefix: 'Add a null check to this getter.',
  latestUserPromptPrefix: null,
  messageCount: 1,
  hasTools: true,
  stream: true,
  providerHints: { provider: null, providerOptions: null },
};

const frontierRouting: RoutingContext = {
  autoModel: 'kilo-auto/frontier',
  candidateModels: [
    'anthropic/claude-opus-4.8',
    'anthropic/claude-sonnet-4.6',
    'openai/gpt-5.5',
    'google/gemini-3.1-pro-preview',
  ],
  resolvedModel: 'anthropic/claude-opus-4.8',
};

function morphResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('routeWithMorphRouter', () => {
  beforeEach(() => {
    clearMorphApiKeyCache();
    apiKeyGet.mockClear();
    mockedFetch.mockReset();
    globalThis.fetch = mockedFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes among mapped candidates and reverse-maps the decision to a Kilo id', async () => {
    mockedFetch.mockResolvedValueOnce(
      morphResponse({
        model: 'gpt-5.5',
        provider: 'openai',
        difficulty: 'hard',
        confidence: 0.91,
        ambiguity: 'low',
        domain: 'coding',
      })
    );

    const outcome = await routeWithMorphRouter(env, frontierRouting, normalizedInput);

    expect(outcome).toEqual({
      kind: 'routed',
      policy: 'capability_heavy',
      candidateCount: 4,
      decision: {
        source: 'morph_router',
        model: 'openai/gpt-5.5',
        routerModel: 'gpt-5.5',
        difficulty: 'hard',
        confidence: 0.91,
        ambiguity: 'low',
        domain: 'coding',
      },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0] ?? [];
    expect(url).toBe(MORPH_ROUTER_ENDPOINT);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer morph-key' });
    expect(JSON.parse(init?.body as string)).toEqual({
      input: 'Add a null check to this getter.',
      allowed_models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'gpt-5.5', 'gemini-3.1-pro-preview'],
      policy: 'capability_heavy',
      default_model: 'claude-opus-4-8',
    });
  });

  it('uses the static resolver pick as the ambiguity fallback default', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ model: 'claude-sonnet-4-6' }));

    await routeWithMorphRouter(
      env,
      { ...frontierRouting, resolvedModel: 'anthropic/claude-sonnet-4.6' },
      normalizedInput
    );

    const body = JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.default_model).toBe('claude-sonnet-4-6');
  });

  it('falls back to the first mapped candidate when the resolved model is unroutable', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ model: 'claude-haiku-4-5-20251001' }));

    const outcome = await routeWithMorphRouter(
      env,
      {
        autoModel: 'kilo-auto/balanced',
        candidateModels: [
          'qwen/qwen3.7-plus',
          'anthropic/claude-haiku-4.5',
          'google/gemini-3.5-flash',
        ],
        resolvedModel: 'qwen/qwen3.7-plus',
      },
      normalizedInput
    );

    const body = JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string);
    // qwen has no Morph catalog mapping, so it is neither an allowed model
    // nor the default.
    expect(body.allowed_models).toEqual(['claude-haiku-4-5-20251001', 'gemini-3.5-flash']);
    expect(body.default_model).toBe('claude-haiku-4-5-20251001');
    expect(body.policy).toBe('balanced');
    expect(outcome).toMatchObject({
      kind: 'routed',
      decision: { model: 'anthropic/claude-haiku-4.5' },
    });
  });

  it('classifies with the latest user prompt when the conversation has continued', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ model: 'gpt-5.5' }));

    await routeWithMorphRouter(env, frontierRouting, {
      ...normalizedInput,
      latestUserPromptPrefix: 'Now refactor the entire module to use the new API.',
    });

    const body = JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.input).toBe('Now refactor the entire module to use the new API.');
  });

  it('skips tiers with fewer than two routable candidates', async () => {
    const outcome = await routeWithMorphRouter(
      env,
      {
        autoModel: 'kilo-auto/balanced',
        candidateModels: ['qwen/qwen3.7-plus', 'google/gemini-3.5-flash'],
        resolvedModel: 'qwen/qwen3.7-plus',
      },
      normalizedInput
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'insufficient_candidates' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('skips tiers without a policy mapping', async () => {
    const outcome = await routeWithMorphRouter(
      env,
      { ...frontierRouting, autoModel: 'kilo-auto/imaginary' },
      normalizedInput
    );

    expect(outcome).toEqual({ kind: 'skipped', reason: 'unknown_tier' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('skips requests without any user prompt to classify', async () => {
    const outcome = await routeWithMorphRouter(env, frontierRouting, {
      ...normalizedInput,
      userPromptPrefix: null,
      latestUserPromptPrefix: null,
    });

    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_prompt' });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects decisions outside the allowed candidate set', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ model: 'claude-haiku-4-5-20251001' }));

    await expect(routeWithMorphRouter(env, frontierRouting, normalizedInput)).rejects.toMatchObject(
      {
        name: 'MorphRouterError',
        failureStage: 'invalid_response',
      }
    );
  });

  it('surfaces upstream HTTP failures with their status', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ error: 'overloaded' }, 503));

    await expect(routeWithMorphRouter(env, frontierRouting, normalizedInput)).rejects.toMatchObject(
      {
        name: 'MorphRouterError',
        failureStage: 'http_503',
      }
    );
  });

  it('maps timeouts to a timeout failure stage', async () => {
    mockedFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));

    await expect(routeWithMorphRouter(env, frontierRouting, normalizedInput)).rejects.toMatchObject(
      {
        name: 'MorphRouterError',
        failureStage: 'timeout',
      }
    );
  });

  it('rejects malformed router responses', async () => {
    mockedFetch.mockResolvedValueOnce(morphResponse({ best: 'gpt-5.5' }));

    await expect(
      routeWithMorphRouter(env, frontierRouting, normalizedInput)
    ).rejects.toBeInstanceOf(MorphRouterError);
  });
});

describe('buildRouterInput', () => {
  it('prefers the latest user prompt and falls back to the initial one', () => {
    expect(buildRouterInput({ ...normalizedInput, latestUserPromptPrefix: 'latest' })).toBe(
      'latest'
    );
    expect(buildRouterInput(normalizedInput)).toBe('Add a null check to this getter.');
    expect(
      buildRouterInput({
        ...normalizedInput,
        userPromptPrefix: '   ',
        latestUserPromptPrefix: null,
      })
    ).toBeNull();
  });
});

describe('routerConfigFingerprint', () => {
  it('is stable across candidate ordering and scoped by policy', () => {
    const reordered = {
      ...frontierRouting,
      candidateModels: [...frontierRouting.candidateModels].reverse(),
    };
    expect(routerConfigFingerprint(reordered)).toBe(routerConfigFingerprint(frontierRouting));
    expect(
      routerConfigFingerprint({ ...frontierRouting, autoModel: 'kilo-auto/balanced' })
    ).not.toBe(routerConfigFingerprint(frontierRouting));
  });
});
