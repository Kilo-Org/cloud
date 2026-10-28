import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  applyKiloExclusiveModelSettings,
  convertFromKiloExclusiveModel,
  findKiloExclusiveModel,
  gemma_4_26b_a4b_it_free_model,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { kiloExclusiveModelFixture } from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';

describe('kiloExclusiveModels', () => {
  test.each([
    'stealth/claude-opus-4.8',
    'stealth/claude-opus-4.7',
    'stealth/claude-sonnet-4.6',
    'stealth/claude-opus-4.6',
    'stealth/qwen3.6-plus',
  ])('no longer serves discounted Martian model %s', modelId => {
    expect(findKiloExclusiveModel(modelId)).toBeNull();
  });

  test('serves the free Gemma 4 26B A4B model', () => {
    expect(findKiloExclusiveModel(gemma_4_26b_a4b_it_free_model.public_id)).toBe(
      gemma_4_26b_a4b_it_free_model
    );
  });
});

describe('applyKiloExclusiveModelSettings', () => {
  const model = { ...kiloExclusiveModelFixture, max_completion_tokens: 1_000 };

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rewrites the public model id to the internal id and keeps the provider config', () => {
    const provider = { only: ['anthropic'], zdr: true };
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: model.public_id, messages: [], provider },
    };

    applyKiloExclusiveModelSettings(request, model);

    expect(request.body.model).toBe(model.internal_id);
    expect(request.body.provider).toBe(provider);
    expect(request.body.provider).toEqual({ only: ['anthropic'], zdr: true });
  });

  test('removes chat completions token limits above the model cap', () => {
    const body = {
      model: model.public_id,
      messages: [],
      max_completion_tokens: 2_000,
      max_tokens: 2_000,
    } as OpenRouterChatCompletionRequest;

    applyKiloExclusiveModelSettings({ kind: 'chat_completions', body }, model);

    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('removes a responses token limit above the model cap', () => {
    const body = {
      model: model.public_id,
      input: '',
      max_output_tokens: 2_000,
    } as GatewayResponsesRequest;

    applyKiloExclusiveModelSettings({ kind: 'responses', body }, model);

    expect(body).not.toHaveProperty('max_output_tokens');
  });

  test('clamps a messages token limit above the model cap', () => {
    const body = {
      model: model.public_id,
      max_tokens: 2_000,
      messages: [],
    } as GatewayMessagesRequest;

    applyKiloExclusiveModelSettings({ kind: 'messages', body }, model);

    expect(body.max_tokens).toBe(1_000);
  });

  test('keeps token limits within the model cap', () => {
    const body = {
      model: model.public_id,
      messages: [],
      max_completion_tokens: 1_000,
    } as OpenRouterChatCompletionRequest;

    applyKiloExclusiveModelSettings({ kind: 'chat_completions', body }, model);

    expect(body.max_completion_tokens).toBe(1_000);
  });
});

describe('convertFromKiloExclusiveModel', () => {
  test('lists the model as free without exposing the internal id', () => {
    const publicModel = convertFromKiloExclusiveModel(kiloExclusiveModelFixture);

    expect(publicModel).toMatchObject({
      id: kiloExclusiveModelFixture.public_id,
      architecture: { input_modalities: ['text', 'image'] },
      pricing: {
        prompt: '0.000000000000',
        completion: '0.000000000000',
        input_cache_read: '0.000000000000',
      },
      isFree: true,
      mayTrainOnYourPrompts: true,
    });
    expect(JSON.stringify(publicModel)).not.toContain(kiloExclusiveModelFixture.internal_id);
  });
});
