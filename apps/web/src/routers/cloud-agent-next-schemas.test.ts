import { describe, expect, it } from '@jest/globals';
import { basePrepareSessionNextSchema } from './cloud-agent-next-schemas';

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
