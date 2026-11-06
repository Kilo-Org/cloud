import { describe, expect, it } from 'vitest';

import { agentColor, stateTint } from '@/lib/agent-color';

describe('stateTint', () => {
  it('gives every state a ramp entry', () => {
    expect(stateTint('unknown').hueTextClass).toMatch(/^text-agent-/);
    expect(stateTint('idle').hueTextClass).toMatch(/^text-agent-/);
    expect(stateTint('live').hueTextClass).toMatch(/^text-agent-/);
  });

  it('keeps the English state words at the search-hash hue of their Latin label', () => {
    // The script-signature contract: the English 'UNKNOWN' string hashes to this
    // entry, so its pin IS that hash and every live surface keeps its hue.
    expect(agentColor('UNKNOWN')).toBe(stateTint('unknown'));
    expect(agentColor('IDLE')).toBe(stateTint('idle'));
  });
});
