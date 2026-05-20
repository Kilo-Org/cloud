import { describe, expect, it } from '@jest/globals';
import {
  baseGetSessionNextOutputSchema,
  basePrepareSessionNextSchema,
} from './cloud-agent-next-schemas';

describe('basePrepareSessionNextSchema', () => {
  it('preserves structured initial slash command payloads', () => {
    const initialPayload = {
      type: 'command' as const,
      command: 'review',
      arguments: 'main',
    };

    const result = basePrepareSessionNextSchema.parse({
      githubRepo: 'kilocode/cloud',
      prompt: '/review main',
      mode: 'code',
      model: 'anthropic/claude-sonnet',
      initialPayload,
    });

    expect(result.initialPayload).toEqual(initialPayload);
  });
});

describe('baseGetSessionNextOutputSchema', () => {
  it('removes callback auth headers from browser-facing runtime state', () => {
    const result = baseGetSessionNextOutputSchema.parse({
      sessionId: 'agent_12345678-1234-1234-1234-123456789abc',
      userId: 'user-123',
      execution: null,
      callbackTarget: {
        url: 'https://callback.example.com/complete',
        headers: {
          'X-Internal-Secret': 'secret-callback-header',
        },
      },
      timestamp: 123456789,
      version: 123456789,
    });

    expect(result.callbackTarget).toEqual({
      url: 'https://callback.example.com/complete',
    });
    expect(result.callbackTarget).not.toHaveProperty('headers');
  });
});
