import { describe, expect, test } from '@jest/globals';
import {
  extractGenerateContentPromptInfo,
  parseGenerateContentMicrodollarUsageFromStream,
  parseGenerateContentMicrodollarUsageFromString,
  processGenerateContentUsage,
} from './processUsage.generateContent';

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  startInactiveSpan: jest.fn(() => ({ end: jest.fn() })),
  getActiveSpan: jest.fn(() => null),
  getRootSpan: jest.fn(() => null),
}));

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function sse(...chunks: unknown[]) {
  return chunks.map(chunk => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('');
}

const usageMetadata = {
  promptTokenCount: 1200,
  cachedContentTokenCount: 1000,
  candidatesTokenCount: 30,
  thoughtsTokenCount: 70,
  totalTokenCount: 1300,
};

describe('processGenerateContentUsage', () => {
  test('counts cached prompt tokens as input and thinking tokens as output', () => {
    expect(processGenerateContentUsage(usageMetadata)).toEqual({
      inputTokens: 1200,
      cacheHitTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 100,
      cost_mUsd: 0,
      is_byok: null,
    });
  });

  test('adds tool-use prompt tokens to the input', () => {
    expect(
      processGenerateContentUsage({ promptTokenCount: 10, toolUsePromptTokenCount: 5 }).inputTokens
    ).toBe(15);
  });

  test('reports zero tokens without usage metadata', () => {
    expect(processGenerateContentUsage(undefined)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
    });
  });
});

describe('parseGenerateContentMicrodollarUsageFromStream', () => {
  test('takes the final usage metadata and the visible text', async () => {
    const stream = streamFromText(
      sse(
        {
          responseId: 'response-1',
          modelVersion: 'gemini-4-argon-contributor',
          candidates: [
            { content: { role: 'model', parts: [{ text: 'thinking...', thought: true }] } },
          ],
          usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 1000 },
        },
        {
          responseId: 'response-1',
          modelVersion: 'gemini-4-argon-contributor',
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'Hello' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata,
        }
      )
    );

    const result = await parseGenerateContentMicrodollarUsageFromStream(
      stream,
      'user-1',
      undefined,
      'direct-byok',
      200
    );

    expect(result).toMatchObject({
      messageId: 'response-1',
      model: 'gemini-4-argon-contributor',
      responseContent: 'Hello',
      finish_reason: 'stop',
      hasError: false,
      streamed: true,
      status_code: 200,
      inputTokens: 1200,
      cacheHitTokens: 1000,
      outputTokens: 100,
      cost_mUsd: 0,
    });
  });

  test('marks an in-stream error and takes its status code', async () => {
    const stream = streamFromText(
      sse(
        { responseId: 'response-1', candidates: [{ content: { parts: [{ text: 'Hi' }] } }] },
        { error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }
      )
    );

    const result = await parseGenerateContentMicrodollarUsageFromStream(
      stream,
      'user-1',
      undefined,
      'direct-byok',
      200
    );

    expect(result).toMatchObject({ hasError: true, status_code: 503, responseContent: 'Hi' });
  });

  test('marks a safety stop as an error', async () => {
    const stream = streamFromText(
      sse({ candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 5 } })
    );

    const result = await parseGenerateContentMicrodollarUsageFromStream(
      stream,
      'user-1',
      undefined,
      'direct-byok',
      200
    );

    expect(result).toMatchObject({ hasError: true, finish_reason: 'safety', inputTokens: 5 });
  });
});

describe('parseGenerateContentMicrodollarUsageFromString', () => {
  test('reads the usage metadata of a non-streaming response', () => {
    const result = parseGenerateContentMicrodollarUsageFromString(
      JSON.stringify({
        responseId: 'response-2',
        modelVersion: 'gemini-4-argon-contributor',
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'plan', thought: true },
                { text: 'Done' },
                { functionCall: { name: 'read', args: {} } },
              ],
            },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata,
      }),
      200
    );

    expect(result).toMatchObject({
      messageId: 'response-2',
      model: 'gemini-4-argon-contributor',
      responseContent: 'Done',
      finish_reason: 'max_tokens',
      hasError: true,
      streamed: false,
      inputTokens: 1200,
      cacheHitTokens: 1000,
      outputTokens: 100,
    });
  });

  test('marks an upstream error body as an error', () => {
    const result = parseGenerateContentMicrodollarUsageFromString(
      JSON.stringify({ error: { code: 400, message: 'bad request', status: 'INVALID_ARGUMENT' } }),
      400
    );

    expect(result).toMatchObject({ hasError: true, status_code: 400, inputTokens: 0 });
  });
});

describe('extractGenerateContentPromptInfo', () => {
  test('takes the system instruction and the last user text, skipping function responses', () => {
    expect(
      extractGenerateContentPromptInfo({
        model: 'gemini-4-argon',
        stream: false,
        systemInstruction: { parts: [{ text: 'You are Kilo' }] },
        contents: [
          { role: 'user', parts: [{ text: 'Read a file' }] },
          { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'read', response: {} } }] },
        ],
      })
    ).toEqual({
      system_prompt_prefix: 'You are Kilo',
      system_prompt_length: 12,
      user_prompt_prefix: 'Read a file',
    });
  });
});
