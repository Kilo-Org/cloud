import type { GatewayRequest, OpenRouterChatCompletionRequest } from '../openrouter/types';
import { replaceReasoningObjectWithReasoningEffort } from '../openrouter/request-helpers';
import type { TransformRequestContext } from '../types';
import type { DirectByokProvider } from './types';
import alibabaTokenPlan from './alibaba-token-plan';
import byteplusCoding from './byteplus-coding';
import chutes from './chutes-byok';
import inceptron from './inceptron-byok';
import kimiCoding from './kimi-coding';
import morph from './morph';
import neuralwatt from './neurowatt';
import ollamaCloud from './ollama-cloud';
import synthetic from './synthetic';
import xiaomiTokenPlanAms from './xiaomi-token-plan-ams';
import xiaomiTokenPlanSgp from './xiaomi-token-plan-sgp';
import zaiCoding from './zai-coding';

function chatRequest(
  body: Partial<OpenRouterChatCompletionRequest>
): Extract<GatewayRequest, { kind: 'chat_completions' }> {
  return { kind: 'chat_completions', body: { model: 'test', messages: [], ...body } };
}

function transform(provider: DirectByokProvider, request: GatewayRequest) {
  provider.transformRequest({ request, extraHeaders: {} } as unknown as TransformRequestContext);
}

describe('replaceReasoningObjectWithReasoningEffort', () => {
  test('carries the reasoning effort over to reasoning_effort', () => {
    const request = chatRequest({ reasoning: { effort: 'high', enabled: true } });

    replaceReasoningObjectWithReasoningEffort(request);

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('high');
  });

  test('keeps an explicit reasoning_effort', () => {
    const request = chatRequest({ reasoning: { effort: 'high' }, reasoning_effort: 'low' });

    replaceReasoningObjectWithReasoningEffort(request);

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body.reasoning_effort).toBe('low');
  });

  test('does not add reasoning_effort without an effort', () => {
    const request = chatRequest({ reasoning: { enabled: true } });

    replaceReasoningObjectWithReasoningEffort(request);

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body).not.toHaveProperty('reasoning_effort');
  });

  test('leaves the Responses API reasoning object alone', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: { model: 'test', input: 'hello', reasoning: { effort: 'high' } },
    };

    replaceReasoningObjectWithReasoningEffort(request);

    expect(request.body.reasoning).toEqual({ effort: 'high' });
  });
});

describe('direct BYOK providers that receive OpenRouter reasoning settings', () => {
  const providers = [
    alibabaTokenPlan,
    byteplusCoding,
    chutes,
    inceptron,
    kimiCoding,
    morph,
    neuralwatt,
    ollamaCloud,
    synthetic,
    xiaomiTokenPlanAms,
    xiaomiTokenPlanSgp,
    zaiCoding,
  ];

  test.each(providers.map(provider => [provider.id, provider] as const))(
    '%s replaces the reasoning object with reasoning_effort',
    (_id, provider) => {
      const request = chatRequest({ reasoning: { effort: 'high' } });

      transform(provider, request);

      expect(request.body).not.toHaveProperty('reasoning');
      expect(request.body.reasoning_effort).toBe('high');
    }
  );

  test.each(
    [byteplusCoding, kimiCoding, zaiCoding].map(provider => [provider.id, provider] as const)
  )('%s still derives thinking from the reasoning object', (_id, provider) => {
    const disabled = chatRequest({ reasoning: { enabled: false, effort: 'none' } });
    const enabled = chatRequest({ reasoning: { enabled: true } });

    transform(provider, disabled);
    transform(provider, enabled);

    expect(disabled.body.thinking).toEqual({ type: 'disabled' });
    expect(enabled.body.thinking).toEqual({ type: 'enabled' });
    expect(disabled.body).not.toHaveProperty('reasoning');
    expect(enabled.body).not.toHaveProperty('reasoning');
  });

  test('kimi-coding drops a carried-over none effort', () => {
    const request = chatRequest({ reasoning: { effort: 'none' } });

    transform(kimiCoding, request);

    expect(request.body).not.toHaveProperty('reasoning');
    expect(request.body).not.toHaveProperty('reasoning_effort');
    expect(request.body.thinking).toEqual({ type: 'disabled' });
  });
});
