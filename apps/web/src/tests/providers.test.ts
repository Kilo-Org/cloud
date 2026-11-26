import { test, expect, describe } from '@jest/globals';
import { extractPromptInfo } from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import type { OpenRouterChatCompletionRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * These tests cover various API formats:
 *
 * OpenAI: Uses "system" role directly in the messages array
 * Anthropic: Uses a top-level "system" parameter (not a "system" role in messages)
 * Gemini: Similar to OpenAI but may have variations
 * DeepSeek: Generally follows OpenAI-compatible format
 */

describe('extractPromptInfo', () => {
  test('should extract system prompt info from standard message format', () => {
    const requestBody = {
      model: 'test-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. Follow these guidelines: be concise, be accurate, be helpful.',
        },
        {
          role: 'user',
          content: 'Tell me about JavaScript promises.',
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(90);
  });

  test('should measure the system prompt when the user message has a content array', () => {
    const requestBody = {
      model: 'test-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.',
        },
        {
          role: 'user',
          content: [
            { type: 'image', image_url: { url: 'https://example.com/image.jpg' } },
            { type: 'text', text: 'Can you explain how React hooks work?' },
            { type: 'text', text: "They're kind of confusing." },
          ],
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(28);
  });

  test('should handle missing system prompt', () => {
    const requestBody = {
      model: 'test-model',
      stream: false,
      messages: [
        {
          role: 'user',
          content: 'What is Node.js?',
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(0);
  });

  test('should handle missing user prompt', () => {
    const requestBody = {
      model: 'test-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.',
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(28);
  });

  test('should handle OpenAI format with system message in messages array', () => {
    const requestBody = {
      model: 'gpt-4',
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful AI assistant that provides accurate information.',
        },
        {
          role: 'user',
          content: 'What are the benefits of TypeScript?',
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(66);
  });

  test('should measure the full length of long system prompts', () => {
    const longSystemPrompt = 'A'.repeat(200);
    const requestBody = {
      model: 'test-model',
      stream: false,
      messages: [
        {
          role: 'system',
          content: longSystemPrompt,
        },
        {
          role: 'user',
          content: 'Hello',
        },
      ],
    } as OpenRouterChatCompletionRequest;

    const result = extractPromptInfo(requestBody);

    expect(result.system_prompt_length).toBe(200);
  });
});
