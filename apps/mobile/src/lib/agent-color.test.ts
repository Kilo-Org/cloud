import { describe, expect, it } from 'vitest';

import {
  agentColor,
  isPlaceholderTint,
  PLACEHOLDER_TINT,
  stateTint,
  toneColor,
} from '@/lib/agent-color';

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
    expect(stateTint('platform').hueClass).toBe('bg-session-strip');
  });

  it('renders the repository a row ran in as muted context, never an accent', () => {
    // The repository labels the row, not the session: the same saturated ramp
    // entry would out-shout the session title the row is about.
    expect(stateTint('repository')).toBe(PLACEHOLDER_TINT);
    expect(stateTint('repository').hueTextClass).toBe('text-muted-foreground');
    expect(stateTint('repository').hueClass).toBe('bg-session-strip');
  });

  it('keeps live at the tint its English word first rendered', () => {
    // The continuity contract: the pre-pin row tint was the hash of the
    // rendered English word, so the LIVE state pin must equal that hash or
    // an existing live surface changes hue for no reason.
    expect(stateTint('live')).toBe(agentColor('LIVE'));
    expect(stateTint('live').hueTextClass).toBe('text-agent-sky');
  });

  it('pins idle to its own muted-cool step, distinct from live', () => {
    // The state contract: idle and live are opposite states on a real
    // session, so each must pin its own ramp entry — never the entry another
    // state already took, and never an agent hash. (The English word's own
    // hash is not the pin: both words hash to sky, the shared value this
    // change unwinds.)
    const idle = stateTint('idle');
    expect(idle.hueTextClass).toBe('text-agent-cloud');
    expect(idle.hueClass).toBe('bg-agent-cloud');
    expect(idle.hueThemeKey).toBe('agentCloud');
    expect(idle).not.toBe(stateTint('live'));
    expect(idle).not.toBe(stateTint('unknown'));
  });

  it('collapses no two states onto one token, so no state tint distinguishes nothing', () => {
    // The regression the doc's table guards: a ramp edit that re-collapses
    // two states fails here before the palette ships. The muted trio shares
    // PLACEHOLDER_TINT by design; idle and live each own one ramp entry.
    const tints = {
      unknown: stateTint('unknown'),
      platform: stateTint('platform'),
      repository: stateTint('repository'),
      idle: stateTint('idle'),
      live: stateTint('live'),
    };
    const identityGroups = new Map<unknown, string[]>();
    for (const [state, tint] of Object.entries(tints)) {
      const list = identityGroups.get(tint) ?? [];
      list.push(state);
      identityGroups.set(tint, list);
    }
    expect(new Set(identityGroups.keys()).size).toBe(3);
    expect(identityGroups.get(stateTint('unknown'))).toEqual(['unknown', 'platform', 'repository']);
    expect(identityGroups.get(stateTint('idle'))).toEqual(['idle']);
    expect(identityGroups.get(stateTint('live'))).toEqual(['live']);
  });
});

describe('isPlaceholderTint', () => {
  it('holds for every state that names the row context', () => {
    for (const state of ['unknown', 'platform', 'repository'] as const) {
      expect(isPlaceholderTint(stateTint(state))).toBe(true);
    }
  });

  it('leaves every accent tint alone, so its strip still dims', () => {
    expect(isPlaceholderTint(agentColor('Cloud'))).toBe(false);
    expect(isPlaceholderTint(agentColor('Some model that hashes elsewhere'))).toBe(false);
    expect(isPlaceholderTint(toneColor('danger'))).toBe(false);
    expect(isPlaceholderTint(stateTint('idle'))).toBe(false);
    expect(isPlaceholderTint(stateTint('live'))).toBe(false);
  });
});
