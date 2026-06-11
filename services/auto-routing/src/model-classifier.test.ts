import { describe, expect, it, vi } from 'vitest';
import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { ClassifierRunError, classifyWithOpenRouter } from './model-classifier';
import type { NormalizedClassifierInput } from './classifier-input';

const normalizedInput = {
  apiKind: 'responses',
  requestedModel: 'openai/gpt-5-mini',
  systemPromptPrefix: 'Classify the request.',
  userPromptPrefix: 'Build a migration plan.',
  messageCount: 2,
  hasTools: false,
  stream: false,
  providerHints: {
    provider: null,
    providerOptions: null,
  },
} satisfies NormalizedClassifierInput;

const modelOutput = {
  taskType: 'planning_design',
  subtaskType: 'technical_planning',
  contextComplexity: 'medium',
  reasoningComplexity: 'medium',
  riskLevel: 'medium',
  executionMode: 'answer_only',
  requiresTools: false,
  confidence: 0.77,
};

describe('OpenRouter classifier call', () => {
  it('sends the compact prompt to the configured classifier and validates the JSON response', async () => {
    const send = vi.fn(
      async (): Promise<ChatResult> => ({
        id: 'gen-test',
        created: 1781010000,
        model: DEFAULT_CLASSIFIER_MODEL,
        object: 'chat.completion',
        systemFingerprint: null,
        choices: [
          {
            finishReason: 'stop',
            index: 0,
            message: { role: 'assistant', content: JSON.stringify(modelOutput) },
          },
        ],
        usage: {
          promptTokens: 100,
          promptTokensDetails: { cachedTokens: 0 },
          completionTokens: 20,
          completionTokensDetails: { reasoningTokens: 0 },
          totalTokens: 120,
          cost: 0.00000123,
        },
      })
    );
    const client = { chat: { send } } as unknown as OpenRouter;

    await expect(
      classifyWithOpenRouter(client, normalizedInput, 'openai/gpt-5-mini')
    ).resolves.toEqual({
      cost: 0.00000123,
      classifierModel: 'openai/gpt-5-mini',
      classification: modelOutput,
      modelCallMeta: {
        finishReason: 'stop',
        completionTokens: 20,
        reasoningTokens: 0,
        textLength: JSON.stringify(modelOutput).length,
      },
    });
    expect(send).toHaveBeenCalledWith({
      chatRequest: {
        model: 'openai/gpt-5-mini',
        messages: expect.any(Array),
        responseFormat: { type: 'json_object' },
        stream: false,
        temperature: 0,
        maxTokens: 256,
      },
    });
  });

  it('falls back when classifier responses have no assistant text', async () => {
    const client = {
      chat: {
        send: vi.fn(
          async (): Promise<ChatResult> => ({
            id: 'gen-test',
            created: 1781010000,
            model: DEFAULT_CLASSIFIER_MODEL,
            object: 'chat.completion',
            systemFingerprint: null,
            choices: [],
          })
        ),
      },
    } as unknown as OpenRouter;

    await expect(
      classifyWithOpenRouter(client, normalizedInput, DEFAULT_CLASSIFIER_MODEL)
    ).resolves.toMatchObject({
      cost: null,
      classifierModel: DEFAULT_CLASSIFIER_MODEL,
      fallback: { reason: 'no_text' },
      classification: {
        taskType: 'planning_design',
        subtaskType: 'technical_planning',
        confidence: 0,
      },
    });
  });

  it('retries once and falls back while preserving classifier cost and model when output validation fails', async () => {
    const send = vi.fn(
      async (): Promise<ChatResult> => ({
        id: 'gen-test',
        created: 1781010000,
        model: DEFAULT_CLASSIFIER_MODEL,
        object: 'chat.completion',
        systemFingerprint: null,
        choices: [
          {
            finishReason: 'stop',
            index: 0,
            message: { role: 'assistant', content: '{"taskType":"invalid"}' },
          },
        ],
        usage: {
          promptTokens: 100,
          promptTokensDetails: { cachedTokens: 0 },
          completionTokens: 20,
          completionTokensDetails: { reasoningTokens: 0 },
          totalTokens: 120,
          cost: 0.00000123,
        },
      })
    );
    const client = { chat: { send } } as unknown as OpenRouter;

    await expect(
      classifyWithOpenRouter(client, normalizedInput, DEFAULT_CLASSIFIER_MODEL)
    ).resolves.toMatchObject({
      cost: 0.00000246,
      classifierModel: DEFAULT_CLASSIFIER_MODEL,
      retried: true,
      firstAttemptFailure: {
        reason: 'invalid_output',
        failureStage: 'invalid_schema',
        finishReason: 'stop',
      },
      fallback: {
        reason: 'invalid_output',
        failureStage: 'invalid_schema',
        schemaIssueSummary: expect.arrayContaining(['subtaskType:invalid_value']),
        topLevelKeys: ['taskType'],
      },
      classification: {
        taskType: 'planning_design',
        subtaskType: 'technical_planning',
        confidence: 0,
      },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('preserves first-attempt cost and diagnostics when the retry throws', async () => {
    const invalidResult: ChatResult = {
      id: 'gen-test',
      created: 1781010000,
      model: DEFAULT_CLASSIFIER_MODEL,
      object: 'chat.completion',
      systemFingerprint: null,
      choices: [
        {
          finishReason: 'stop',
          index: 0,
          message: { role: 'assistant', content: '{"taskType":"invalid"}' },
        },
      ],
      usage: {
        promptTokens: 100,
        promptTokensDetails: { cachedTokens: 0 },
        completionTokens: 20,
        completionTokensDetails: { reasoningTokens: 0 },
        totalTokens: 120,
        cost: 0.00000123,
      },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce(invalidResult)
      .mockRejectedValueOnce(new Error('upstream connection reset'));
    const client = { chat: { send } } as unknown as OpenRouter;

    const error = await classifyWithOpenRouter(client, normalizedInput, DEFAULT_CLASSIFIER_MODEL)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ClassifierRunError);
    expect(error).toMatchObject({
      message: 'upstream connection reset',
      cost: 0.00000123,
      classifierModel: DEFAULT_CLASSIFIER_MODEL,
      failureStage: 'invalid_schema',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
