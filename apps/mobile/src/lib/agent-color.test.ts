import { describe, expect, it } from 'vitest';

import { agentColor, PLACEHOLDER_TINT, stateTint } from '@/lib/agent-color';

describe('stateTint', () => {
  it('renders the unknown origin as a muted placeholder, never an accent', () => {
    expect(stateTint('unknown')).toBe(PLACEHOLDER_TINT);
    expect(stateTint('unknown').hueTextClass).toBe('text-muted-foreground');
    expect(stateTint('unknown').hueTextClass).not.toMatch(/^text-agent-/);
  });

  it('renders the agent type as muted metadata, so the title leads the row', () => {
    // A row whose eyebrow can only name the kind of agent it ran on is not
    // naming itself: an accent there competes with the title beside it.
    expect(stateTint('platform')).toBe(PLACEHOLDER_TINT);
    expect(stateTint('platform').hueClass).toBe('bg-muted-soft');
  });

  it('renders the repository a row ran in as muted context, never an accent', () => {
    // The repository labels the row, not the session: the same saturated ramp
    // entry would out-shout the session title the row is about.
    expect(stateTint('repository')).toBe(PLACEHOLDER_TINT);
    expect(stateTint('repository').hueTextClass).toBe('text-muted-foreground');
    expect(stateTint('repository').hueClass).toBe('bg-muted-soft');
  });

  it('keeps each live state at the tint its English word first rendered', () => {
    // The continuity contract: the pre-pin row tint was the hash of the
    // rendered English word, so each state pin must equal that hash or an
    // existing live surface changes hue for no reason.
    expect(stateTint('idle')).toBe(agentColor('IDLE'));
    expect(stateTint('live')).toBe(agentColor('LIVE'));
  });
});
