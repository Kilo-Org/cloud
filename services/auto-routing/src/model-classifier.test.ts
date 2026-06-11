import { describe, expect, it, vi } from 'vitest';
import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { DEFAULT_CLASSIFIER_MODEL } from './classifier-prompt';
import { classifyWithOpenRouter, type ClassifierRunError } from './model-classifier';
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
  it('sends the compact prompt to the Gemma classifier and validates the JSON response', async () => {
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
    });
    expect(send).toHaveBeenCalledWith({
      chatRequest: {
        model: 'openai/gpt-5-mini',
        messages: expect.any(Array),
        responseFormat: { type: 'json_object' },
        stream: false,
        temperature: 0,
        maxTokens: 400,
      },
    });
  });

  it('rejects classifier responses without assistant text', async () => {
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
    ).rejects.toMatchObject({
      message: 'Classifier model returned no text',
      cost: null,
      classifierModel: DEFAULT_CLASSIFIER_MODEL,
    } satisfies Partial<ClassifierRunError>);
  });

  it('preserves classifier cost and model when output validation fails', async () => {
    const client = {
      chat: {
        send: vi.fn(
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
        ),
      },
    } as unknown as OpenRouter;

    await expect(
      classifyWithOpenRouter(client, normalizedInput, DEFAULT_CLASSIFIER_MODEL)
    ).rejects.toMatchObject({
      message: 'Classifier model returned invalid classification',
      cost: 0.00000123,
      classifierModel: DEFAULT_CLASSIFIER_MODEL,
    } satisfies Partial<ClassifierRunError>);
  });
});
