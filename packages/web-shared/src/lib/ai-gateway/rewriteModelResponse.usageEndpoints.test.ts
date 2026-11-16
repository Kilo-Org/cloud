import { describe, expect, test } from '@jest/globals';
import {
  rewriteBilledResponse_UsageEndpoint,
  rewriteBilledUsageEndpointBody,
  rewriteModelResponse_UsageEndpoint,
  rewriteUsageEndpointBody,
  responseUsageContext,
} from './rewriteModelResponse.usageEndpoints';
import type { ResponseUsageContext } from './rewriteModelResponse.shared';
import { TEST_CUSTOM_PRICING_CONFIG } from '@kilocode/web-shared/tests/helpers/custom-pricing.helper';
import type { MicrodollarUsageContext } from './processUsage.types';
import { parseJson } from './processUsage.shared';

const context = {
  requested_model: 'openai/text-embedding-3-small',
  provider: 'openrouter',
  api_kind: 'embeddings',
  is_free: false,
  user_byok: false,
  custom_llm_pricing: null,
  custom_pricing_config: TEST_CUSTOM_PRICING_CONFIG,
} satisfies ResponseUsageContext;

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

describe('rewriteUsageEndpointBody', () => {
  test('rewrites the model to the requested id', () => {
    const body = { model: 'openai/text-embedding-3-small-20240125', usage: { cost: 0 } };
    rewriteUsageEndpointBody(body, context);
    expect(body.model).toBe('openai/text-embedding-3-small');
  });

  test.each(['~anthropic/claude-sonnet-latest', 'openrouter/auto'])(
    'keeps the upstream model for the exempt id %s',
    requested => {
      const body = { model: 'upstream/model' };
      rewriteUsageEndpointBody(body, { ...context, requested_model: requested });
      expect(body.model).toBe('upstream/model');
    }
  );

  test('leaves a body without a model without adding one', () => {
    const body = {};
    rewriteUsageEndpointBody(body, context);
    expect(body).toEqual({});
  });

  test('removes upstream provider metadata', () => {
    const body = { model: 'm', providerMetadata: { gateway: {} }, provider_metadata: {} };
    rewriteUsageEndpointBody(body, context);
    expect(body).toEqual({ model: 'openai/text-embedding-3-small' });
  });

  test('reports the billed cost of a paid request', () => {
    const body = { usage: { prompt_tokens: 10, cost: 0.000002, is_byok: false } };
    rewriteUsageEndpointBody(body, context);
    expect(body.usage).toEqual({ prompt_tokens: 10, cost: 0.000002, is_byok: false });
  });

  test('zeroes the cost of a free model', () => {
    const body = { usage: { prompt_tokens: 10, cost: 0.000002, is_byok: false } };
    rewriteUsageEndpointBody(body, { ...context, is_free: true });
    expect(body.usage).toEqual({ prompt_tokens: 10, cost: 0, is_byok: false });
  });

  test('zeroes the cost of a BYOK request and reports it as BYOK', () => {
    const body = {
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cost: 0.00001,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0002 },
      },
    };
    rewriteUsageEndpointBody(body, { ...context, user_byok: true });
    expect(body.usage).toMatchObject({ cost: 0, is_byok: true });
  });

  test('bills the upstream inference cost of a BYOK response to a request not flagged as BYOK', () => {
    const body = {
      usage: {
        prompt_tokens: 10,
        cost: 0.0000105,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.0002 },
      },
    };
    rewriteUsageEndpointBody(body, context);
    expect(body.usage).toMatchObject({ cost: 0.0002, is_byok: false });
  });

  test('prices from the Vercel provider metadata when usage has no cost', () => {
    const body = {
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 10 },
      providerMetadata: { gateway: { cost: '0.000003', marketCost: '0.000004' } },
    };
    rewriteUsageEndpointBody(body, { ...context, provider: 'vercel' });
    expect(body).toEqual({
      model: 'openai/text-embedding-3-small',
      usage: {
        prompt_tokens: 10,
        cost: 0.000004,
        is_byok: false,
        cost_details: { upstream_inference_cost: 0.000004 },
      },
    });
  });

  test.each([['n/a'], [5], [true], [[1]], [null]])('leaves the primitive usage %j alone', usage => {
    const body = { model: 'upstream/model', usage } as Parameters<
      typeof rewriteUsageEndpointBody
    >[0];
    rewriteUsageEndpointBody(body, context);
    expect(body).toEqual({ model: 'openai/text-embedding-3-small', usage });
  });

  test('leaves a paid transcription cost without a BYOK flag as the upstream reported it', () => {
    const body = { usage: { input_tokens: 10, cost: 0.00002 } };
    rewriteUsageEndpointBody(body, { ...context, api_kind: 'audio_transcriptions' });
    expect(body.usage).toEqual({ input_tokens: 10, cost: 0.00002 });
  });

  test('applies custom pricing to a transcription cost without a BYOK flag and drops internal fields', () => {
    const body = {
      usage: { input_tokens: 1_000_000, output_tokens: 0, cost: 0.5, market_cost: 0.5 },
    };
    rewriteUsageEndpointBody(body, {
      ...context,
      api_kind: 'audio_transcriptions',
      custom_llm_pricing: [
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 2,
            completion_per_million: 3,
            input_cache_read_per_million: null,
            input_cache_write_per_million: null,
          },
        },
      ],
    });
    expect(body.usage).toMatchObject({ cost: 2, is_byok: false });
    expect(body.usage).not.toHaveProperty('market_cost');
  });

  test('zeroes a free transcription even without a BYOK flag', () => {
    const body = { usage: { input_tokens: 10, cost: 0.00002 } };
    rewriteUsageEndpointBody(body, { ...context, api_kind: 'audio_transcriptions', is_free: true });
    expect(body.usage).toEqual({ input_tokens: 10, cost: 0, is_byok: false });
  });

  test('drops the internal cost fields', () => {
    const body = {
      usage: { cost: 0.001, market_cost: 0.001, gateway_cost: 0.001 },
    };
    rewriteUsageEndpointBody(body, context);
    expect(body.usage).not.toHaveProperty('market_cost');
    expect(body.usage).not.toHaveProperty('gateway_cost');
  });

  test('applies custom pricing to the input and output tokens', () => {
    const body = { usage: { input_tokens: 1_000_000, output_tokens: 1_000_000, cost: 1 } };
    rewriteUsageEndpointBody(body, {
      ...context,
      custom_llm_pricing: [
        {
          start_context_length: 0,
          pricing: {
            prompt_per_million: 2,
            completion_per_million: 3,
            input_cache_read_per_million: null,
            input_cache_write_per_million: null,
          },
        },
      ],
    });
    expect(body.usage.cost).toBe(5);
  });
});

describe('rewriteModelResponse_UsageEndpoint', () => {
  const params = { usageContext: context, vercelRequestId: null };

  test('rewrites the model and cost of a JSON response', async () => {
    const rewritten = await rewriteModelResponse_UsageEndpoint({
      ...params,
      usageContext: { ...context, is_free: true },
      response: jsonResponse({
        object: 'list',
        data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }],
        model: 'openai/text-embedding-3-small-20240125',
        usage: { prompt_tokens: 3, total_tokens: 3, cost: 0.000001 },
      }),
    });

    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get('content-type')).toContain('application/json');
    expect(rewritten.headers.get('content-encoding')).toBe('identity');
    await expect(rewritten.json()).resolves.toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.25, -0.5] }],
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 3, total_tokens: 3, cost: 0, is_byok: false },
    });
  });

  test('passes an error response through untouched', async () => {
    const rewritten = await rewriteModelResponse_UsageEndpoint({
      ...params,
      response: jsonResponse(
        { error: { message: 'nope' }, model: 'upstream/model' },
        { status: 404 }
      ),
    });

    expect(rewritten.status).toBe(404);
    await expect(rewritten.json()).resolves.toEqual({
      error: { message: 'nope' },
      model: 'upstream/model',
    });
  });

  test.each(['not json', '[1,2]', 'null'])('passes the body %j through', async text => {
    const rewritten = await rewriteModelResponse_UsageEndpoint({
      ...params,
      response: new Response(text, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    expect(rewritten.status).toBe(200);
    await expect(rewritten.text()).resolves.toBe(text);
  });

  test('passes a plain-text body through even when it looks like a JSON object', async () => {
    const text = '{"model":"spoken","usage":{"cost":1}}';
    const rewritten = await rewriteModelResponse_UsageEndpoint({
      ...params,
      response: new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } }),
    });

    await expect(rewritten.text()).resolves.toBe(text);
  });

  test('answers a timeout while reading the body with a 503 naming the request', async () => {
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new DOMException('timed out', 'TimeoutError'));
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

    const rewritten = await rewriteModelResponse_UsageEndpoint({
      ...params,
      vercelRequestId: 'fra1::abc',
      response,
    });

    expect(rewritten.status).toBe(503);
    await expect(rewritten.json()).resolves.toMatchObject({
      error_type: 'timeout',
      message: expect.stringContaining('fra1::abc'),
    });
  });
});

describe('rewriteBilledUsageEndpointBody', () => {
  test('reports the billed cost instead of pricing the body again', () => {
    const body = {
      model: 'openai/text-embedding-3-small-20240125',
      usage: { prompt_tokens: 10, cost: 0.000002, is_byok: true, market_cost: 0.000002 },
      provider_metadata: { gateway: {} },
    };
    rewriteBilledUsageEndpointBody(body, { cost_mUsd: 7 }, context);
    expect(body).toEqual({
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 10, cost: 0.000007, is_byok: false },
    });
  });

  test('reports a BYOK request as BYOK and the Vercel upstream cost', () => {
    const body = {
      usage: { prompt_tokens: 10 },
      providerMetadata: { gateway: { cost: '0', marketCost: '0.000004' } },
    };
    rewriteBilledUsageEndpointBody(body, { cost_mUsd: 0 }, { ...context, user_byok: true });
    expect(body).toEqual({
      usage: {
        prompt_tokens: 10,
        cost: 0,
        is_byok: true,
        cost_details: { upstream_inference_cost: 0.000004 },
      },
    });
  });

  test.each([['n/a'], [null]])('leaves the usage %j alone', usage => {
    const body = { model: 'upstream/model', usage } as Parameters<
      typeof rewriteBilledUsageEndpointBody
    >[0];
    rewriteBilledUsageEndpointBody(body, { cost_mUsd: 7 }, context);
    expect(body).toEqual({ model: 'openai/text-embedding-3-small', usage });
  });
});

describe('rewriteBilledResponse_UsageEndpoint', () => {
  function respond(
    text: string,
    billed: Promise<{ cost_mUsd: number } | null>,
    init: ResponseInit = { headers: { 'content-type': 'application/json' } }
  ) {
    return rewriteBilledResponse_UsageEndpoint({
      response: new Response(null, init),
      body: Promise.resolve({ text, json: parseJson(text) }),
      billed,
      usageContext: context,
      vercelRequestId: null,
    });
  }

  const upstream = JSON.stringify({
    model: 'openai/text-embedding-3-small-20240125',
    usage: { prompt_tokens: 3, cost: 0.000001, is_byok: false },
  });

  test('reports the billed cost and the requested model', async () => {
    const rewritten = await respond(upstream, Promise.resolve({ cost_mUsd: 9 }));

    expect(rewritten.status).toBe(200);
    expect(rewritten.headers.get('content-encoding')).toBe('identity');
    await expect(rewritten.json()).resolves.toEqual({
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 3, cost: 0.000009, is_byok: false },
    });
  });

  test.each([
    { name: 'unpriced', billed: () => Promise.resolve(null) },
    { name: 'failed', billed: () => Promise.reject(new Error('pricing failed')) },
  ])('prices the body itself when the billing $name', async ({ billed }) => {
    const rewritten = await respond(upstream, billed());

    await expect(rewritten.json()).resolves.toEqual({
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 3, cost: 0.000001, is_byok: false },
    });
  });

  test('passes an error response through untouched', async () => {
    const text = JSON.stringify({ error: { message: 'nope' }, model: 'upstream/model' });
    const rewritten = await respond(text, Promise.resolve({ cost_mUsd: 0 }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' },
    });

    expect(rewritten.status).toBe(404);
    expect(rewritten.statusText).toBe('Not Found');
    await expect(rewritten.text()).resolves.toBe(text);
  });

  test.each(['not json', '[1,2]', 'null'])('passes the body %j through', async text => {
    const rewritten = await respond(text, Promise.resolve(null));

    expect(rewritten.status).toBe(200);
    await expect(rewritten.text()).resolves.toBe(text);
  });

  test('passes a plain-text body through even when it looks like a JSON object', async () => {
    const text = '{"model":"spoken","usage":{"cost":1}}';
    const rewritten = await respond(text, Promise.resolve({ cost_mUsd: 0 }), {
      headers: { 'content-type': 'text/plain' },
    });

    await expect(rewritten.text()).resolves.toBe(text);
  });

  test('passes a response without a body through', async () => {
    const rewritten = await rewriteBilledResponse_UsageEndpoint({
      response: new Response(null, { headers: { 'content-type': 'application/json' } }),
      body: Promise.resolve(null),
      billed: Promise.resolve(null),
      usageContext: context,
      vercelRequestId: null,
    });

    expect(rewritten.status).toBe(200);
    await expect(rewritten.text()).resolves.toBe('');
  });

  test('answers a timeout while reading the body with a 503 naming the request', async () => {
    const rewritten = await rewriteBilledResponse_UsageEndpoint({
      response: new Response(null, { headers: { 'content-type': 'application/json' } }),
      body: Promise.reject(new DOMException('timed out', 'TimeoutError')),
      billed: Promise.resolve(null),
      usageContext: context,
      vercelRequestId: 'fra1::abc',
    });

    expect(rewritten.status).toBe(503);
    await expect(rewritten.json()).resolves.toMatchObject({
      error_type: 'timeout',
      message: expect.stringContaining('fra1::abc'),
    });
  });

  test('rethrows any other read error', async () => {
    const readError = new Error('unexpected');
    await expect(
      rewriteBilledResponse_UsageEndpoint({
        response: new Response(null, { headers: { 'content-type': 'application/json' } }),
        body: Promise.reject(readError),
        billed: Promise.resolve(null),
        usageContext: context,
        vercelRequestId: null,
      })
    ).rejects.toBe(readError);
  });
});

describe('responseUsageContext', () => {
  test('keeps only the fields that decide the response', () => {
    const usageContext = {
      api_kind: 'systemone',
      provider: 'openrouter',
      requested_model: 'typesafe/jev-1.13',
      is_free: false,
      user_byok: false,
      custom_llm_pricing: null,
      kiloUserId: 'user-1',
    } as MicrodollarUsageContext;

    expect(responseUsageContext(usageContext, TEST_CUSTOM_PRICING_CONFIG)).toEqual({
      api_kind: 'systemone',
      provider: 'openrouter',
      requested_model: 'typesafe/jev-1.13',
      is_free: false,
      user_byok: false,
      custom_llm_pricing: null,
      custom_pricing_config: TEST_CUSTOM_PRICING_CONFIG,
    });
  });
});
