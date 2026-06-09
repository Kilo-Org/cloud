import { describe, expect, it, vi } from 'vitest';
import type { OpenRouter } from '@openrouter/sdk';
import type { ChatResult } from '@openrouter/sdk/models';
import { CLASSIFIER_MODEL } from './classifier-prompt';
import { classifyWithOpenRouter } from './model-classifier';
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
        model: CLASSIFIER_MODEL,
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

    await expect(classifyWithOpenRouter(client, normalizedInput)).resolves.toEqual({
      cost: 0.00000123,
      classification: modelOutput,
    });
    expect(send).toHaveBeenCalledWith({
      chatRequest: {
        model: CLASSIFIER_MODEL,
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
            model: CLASSIFIER_MODEL,
            object: 'chat.completion',
            systemFingerprint: null,
            choices: [],
          })
        ),
      },
    } as unknown as OpenRouter;

    await expect(classifyWithOpenRouter(client, normalizedInput)).rejects.toThrow(
      'Classifier model returned no text'
    );
  });
});
