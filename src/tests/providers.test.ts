import { test, expect, describe } from '@jest/globals';
import { extractPromptInfo } from '../lib/processUsage';
import type { OpenRouterChatCompletionRequest } from '../lib/providers/openrouter/types';

/**
 * These tests cover various API formats:
 *
 * OpenAI: Uses "system" role directly in the messages array
 * Anthropic: Uses a top-level "system" parameter (not a "system" role in messages)
 * Gemini: Similar to OpenAI but may have variations
 * DeepSeek: Generally follows OpenAI-compatible format
 */

describe('extractPromptInfo', () => {
  test('should extract system and user prompt info from standard message format', () => {
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

    expect(result.system_prompt_prefix).toBe(
      'You are a helpful assistant. Follow these guidelines: be concise, be accurate, be helpful.'
    );
    expect(result.system_prompt_length).toBe(90);
    expect(result.user_prompt_prefix).toBe('Tell me about JavaScript promises.');
  });

  test('should handle user message with content array format', () => {
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

    expect(result.system_prompt_prefix).toBe('You are a helpful assistant.');
    expect(result.system_prompt_length).toBe(28);
    expect(result.user_prompt_prefix).toBe(
      "Can you explain how React hooks work?\nThey're kind of confusing."
    );
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

    expect(result.system_prompt_prefix).toBe('');
    expect(result.system_prompt_length).toBe(0);
    expect(result.user_prompt_prefix).toBe('What is Node.js?');
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

    expect(result.system_prompt_prefix).toBe('You are a helpful assistant.');
    expect(result.system_prompt_length).toBe(28);
    expect(result.user_prompt_prefix).toBe('');
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

    expect(result.system_prompt_prefix).toBe(
      'You are a helpful AI assistant that provides accurate information.'
    );
    expect(result.system_prompt_length).toBe(66);
    expect(result.user_prompt_prefix).toBe('What are the benefits of TypeScript?');
  });

  test('should truncate long system prompts to 100 chars for prefix', () => {
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

    expect(result.system_prompt_prefix).toBe('A'.repeat(100));
    expect(result.system_prompt_length).toBe(200);
  });
});
