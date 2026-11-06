import { describe, expect, it } from 'vitest';

import { agentColor, stateTint } from '@/lib/agent-color';

describe('stateTint', () => {
  it('gives every state a ramp entry', () => {
    expect(stateTint('unknown').hueTextClass).toMatch(/^text-agent-/);
    expect(stateTint('idle').hueTextClass).toMatch(/^text-agent-/);
    expect(stateTint('live').hueTextClass).toMatch(/^text-agent-/);
  });

  it('keeps each state at the tint its English word first rendered', () => {
    // The continuity contract: the pre-pin row tint was the hash of the
    // rendered English word, so each pin must equal that hash or an existing
    // surface changes hue for no reason.
    expect(stateTint('unknown')).toBe(agentColor('UNKNOWN'));
    expect(stateTint('idle')).toBe(agentColor('IDLE'));
    expect(stateTint('live')).toBe(agentColor('LIVE'));
  });
});
