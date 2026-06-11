import { describe, expect, it } from 'vitest';
import type { MirrorPayload } from '@kilocode/auto-routing-contracts';
import { parseClassifierInput } from './classifier-input';

function payload(body: unknown, path: MirrorPayload['path'] = '/chat/completions'): MirrorPayload {
  return {
    path,
    receivedAt: '2026-06-11T00:00:00.000Z',
    sessionId: 'session-123',
    headers: {},
    body: JSON.stringify(body),
  };
}

describe('classifier input parsing', () => {
  it('captures the first and latest user prompt text for long chat completion sessions', () => {
    expect(
      parseClassifierInput(
        payload({
          model: 'anthropic/claude-sonnet-4',
          messages: [
            { role: 'system', content: 'You are Kilo Code.' },
            { role: 'user', content: '<task>Add tests for the parser.</task>' },
            { role: 'assistant', content: 'I will inspect the repo.' },
            { role: 'user', content: 'Actually focus on latency instead.' },
          ],
        })
      )
    ).toMatchObject({
      success: true,
      data: {
        userPromptPrefix: '<task>Add tests for the parser.</task>',
        latestUserPromptPrefix: 'Actually focus on latency instead.',
      },
    });
  });

  it('captures the first and latest user prompt text for responses input arrays', () => {
    expect(
      parseClassifierInput(
        payload(
          {
            model: 'openai/gpt-5-mini',
            input: [
              { role: 'user', content: 'Draft an implementation plan.' },
              { role: 'assistant', content: 'Here is a plan.' },
              { role: 'user', content: [{ type: 'input_text', text: 'Now implement it.' }] },
            ],
          },
          '/responses'
        )
      )
    ).toMatchObject({
      success: true,
      data: {
        userPromptPrefix: 'Draft an implementation plan.',
        latestUserPromptPrefix: 'Now implement it.',
      },
    });
  });
});
