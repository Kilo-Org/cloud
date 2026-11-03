import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  applyAutoSmallFreeModelSettings,
  autoSmallFreeModelUpstreamId,
  isAutoSmallFreeModel,
} from '@kilocode/web-shared/lib/ai-gateway/auto-small-free-model';
import { AUTO_SMALL_TARGET_MODELS } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const freeModelId = 'google/gemma-4-26b-a4b-it:free';
const paidModelId = 'google/gemma-4-26b-a4b-it';
const maxCompletionTokens = 32_768;

describe('isAutoSmallFreeModel', () => {
  test('matches the free model kilo-auto/small routes to', () => {
    expect(AUTO_SMALL_TARGET_MODELS.free).toBe(freeModelId);
    expect(isAutoSmallFreeModel(freeModelId)).toBe(true);
  });

  test.each([paidModelId, 'google/gemma-4-31b-it:free', 'kilo-auto/small', 'openrouter/free'])(
    'does not match %s',
    modelId => {
      expect(isAutoSmallFreeModel(modelId)).toBe(false);
    }
  );
});

describe('autoSmallFreeModelUpstreamId', () => {
  test('maps the free model to the paid model', () => {
    expect(AUTO_SMALL_TARGET_MODELS.paid).toBe(paidModelId);
    expect(autoSmallFreeModelUpstreamId(freeModelId)).toBe(paidModelId);
  });

  test('keeps other model ids', () => {
    expect(autoSmallFreeModelUpstreamId('anthropic/claude-sonnet-4')).toBe(
      'anthropic/claude-sonnet-4'
    );
  });
});

describe('applyAutoSmallFreeModelSettings', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('rewrites the free model id to the paid id and keeps the provider config', () => {
    const provider = { only: ['novita'], zdr: true };
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: freeModelId, messages: [], provider },
    };

    applyAutoSmallFreeModelSettings(request);

    expect(request.body.model).toBe(paidModelId);
    expect(request.body.provider).toBe(provider);
    expect(request.body.provider).toEqual({ only: ['novita'], zdr: true });
  });

  test('removes chat completions token limits above the model cap', () => {
    const body = {
      model: freeModelId,
      messages: [],
      max_completion_tokens: maxCompletionTokens + 1,
      max_tokens: maxCompletionTokens + 1,
    } as OpenRouterChatCompletionRequest;

    applyAutoSmallFreeModelSettings({ kind: 'chat_completions', body });

    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  test('removes a responses token limit above the model cap', () => {
    const body = {
      model: freeModelId,
      input: '',
      max_output_tokens: maxCompletionTokens + 1,
    } as GatewayResponsesRequest;

    applyAutoSmallFreeModelSettings({ kind: 'responses', body });

    expect(body.model).toBe(paidModelId);
    expect(body).not.toHaveProperty('max_output_tokens');
  });

  test('clamps a messages token limit above the model cap', () => {
    const body = {
      model: freeModelId,
      max_tokens: maxCompletionTokens + 1,
      messages: [],
    } as GatewayMessagesRequest;

    applyAutoSmallFreeModelSettings({ kind: 'messages', body });

    expect(body.model).toBe(paidModelId);
    expect(body.max_tokens).toBe(maxCompletionTokens);
  });

  test('keeps token limits within the model cap', () => {
    const body = {
      model: freeModelId,
      messages: [],
      max_completion_tokens: maxCompletionTokens,
      max_tokens: maxCompletionTokens,
    } as OpenRouterChatCompletionRequest;

    applyAutoSmallFreeModelSettings({ kind: 'chat_completions', body });

    expect(body.max_completion_tokens).toBe(maxCompletionTokens);
    expect(body.max_tokens).toBe(maxCompletionTokens);
  });
});
