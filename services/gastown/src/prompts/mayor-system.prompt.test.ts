import { describe, it, expect } from 'vitest';
import { buildMayorSystemPrompt } from './mayor-system.prompt';

describe('buildMayorSystemPrompt', () => {
  const params = {
    identity: 'mayor-alpha',
    townId: 'town-abc',
  };

  it('should include duplicate bead prevention instructions', () => {
    const prompt = buildMayorSystemPrompt(params);
    expect(prompt).toContain('Ensure you do not create duplicate beads.');
  });
});
