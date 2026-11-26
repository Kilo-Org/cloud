import { describe, expect, test } from '@jest/globals';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { determineFallbackFeature } from '@kilocode/web-shared/lib/ai-gateway/determineFallbackFeature';

function requestWithSystemPrompt(systemPrompt?: string): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'anthropic/claude-sonnet-4',
      messages: systemPrompt === undefined ? [] : [{ role: 'system', content: systemPrompt }],
    },
  };
}

const request = requestWithSystemPrompt();

describe('determineFallbackFeature', () => {
  test('does not fall back for Kilo Code user agents', () => {
    expect(determineFallbackFeature(request, 'Kilo-Code/5.12.0')).toBe('');
  });

  test('falls back for other user agents', () => {
    expect(determineFallbackFeature(request, 'Other/1.0')).toBe('direct-gateway');
  });

  test.each([
    ['Kilo', 'You are Kilo, a highly skilled software engineer.'],
    ['Kilo legacy', 'You are Kilo Code, an expert software debugger.'],
    ['OpenClaw', 'You are a personal assistant running inside OpenClaw.\n## Tooling'],
  ])('does not fall back for a %s system prompt', (_name, systemPrompt) => {
    expect(determineFallbackFeature(requestWithSystemPrompt(systemPrompt), 'Other/1.0')).toBe('');
  });

  test.each([
    ['Codex', 'You are Codex, an agent based on GPT-6.'],
    ['generic', 'You are a helpful assistant.'],
  ])('falls back for a %s system prompt', (_name, systemPrompt) => {
    expect(determineFallbackFeature(requestWithSystemPrompt(systemPrompt), 'Other/1.0')).toBe(
      'direct-gateway'
    );
  });
});

describe('determineFallbackFeature system prompt detection', () => {
  const longPadding = 'x'.repeat(100);
  const cases: Array<[string, GatewayRequest]> = [
    [
      'chat completions',
      {
        kind: 'chat_completions',
        body: {
          model: 'anthropic/claude-sonnet-4',
          messages: [
            { role: 'system', content: 'You are Kilo Code.' },
            { role: 'user', content: 'Hi' },
          ],
        },
      },
    ],
    [
      'messages',
      {
        kind: 'messages',
        body: {
          model: 'anthropic/claude-sonnet-4',
          max_tokens: 10,
          system: [{ type: 'text', text: 'You are Kilo Code.' }],
          messages: [{ role: 'user', content: 'Hi' }],
        },
      },
    ],
    [
      'responses',
      {
        kind: 'responses',
        body: {
          model: 'openai/gpt-5.4',
          instructions: 'You are Kilo Code.',
          input: [{ role: 'user', content: 'Hi' }],
        },
      },
    ],
  ];

  test.each(cases)('does not fall back for a Kilo system prompt in %s', (_name, kiloRequest) => {
    expect(determineFallbackFeature(kiloRequest, 'Other/1.0')).toBe('');
  });

  test('classifies the whole system prompt, not only its start', () => {
    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: {
        model: 'anthropic/claude-sonnet-4',
        messages: [{ role: 'system', content: `${longPadding}You are Kilo Code.` }],
      },
    };
    expect(determineFallbackFeature(request, 'Other/1.0')).toBe('');
  });

  test('falls back when a chat completions body cannot be read', () => {
    const request = {
      kind: 'chat_completions',
      body: { model: 'anthropic/claude-sonnet-4', messages: 'not-a-message-list' },
    } as unknown as GatewayRequest;
    expect(determineFallbackFeature(request, 'Other/1.0')).toBe('direct-gateway');
  });
});
