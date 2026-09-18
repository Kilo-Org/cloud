import { describe, expect, it } from 'vitest';

import {
  formatSessionProfileCounts,
  resolveSessionProfileLayerIds,
  resolveSessionProfilePicker,
  type SessionProfilePickerProfile,
} from './session-profile-picker-model';

function profile(
  overrides: Partial<SessionProfilePickerProfile> & { id: string; name: string }
): SessionProfilePickerProfile {
  return {
    varCount: 0,
    mcpServerCount: 0,
    skillCount: 0,
    kiloCommandCount: 0,
    ...overrides,
  };
}

describe('resolveSessionProfileLayerIds', () => {
  it('applies the effective default as the top layer when nothing is picked', () => {
    expect(
      resolveSessionProfileLayerIds({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: 'default',
        explicitOverrideProfileId: null,
      })
    ).toEqual({ baseProfileId: null, topProfileId: 'default', topSource: 'default' });
  });

  it('lets the explicit pick replace the effective default in the top slot', () => {
    expect(
      resolveSessionProfileLayerIds({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: 'default',
        explicitOverrideProfileId: 'picked',
      })
    ).toEqual({ baseProfileId: null, topProfileId: 'picked', topSource: 'explicit' });
  });

  it('keeps the repo binding as the base and layers the pick on top', () => {
    expect(
      resolveSessionProfileLayerIds({
        repoBindingProfileId: 'repo',
        effectiveDefaultProfileId: 'default',
        explicitOverrideProfileId: 'picked',
      })
    ).toEqual({ baseProfileId: 'repo', topProfileId: 'picked', topSource: 'explicit' });
  });

  it('drops the top layer when it duplicates the repo base', () => {
    expect(
      resolveSessionProfileLayerIds({
        repoBindingProfileId: 'same',
        effectiveDefaultProfileId: 'same',
        explicitOverrideProfileId: 'same',
      })
    ).toEqual({ baseProfileId: 'same', topProfileId: null, topSource: null });
  });

  it('resolves no layers when nothing applies', () => {
    expect(
      resolveSessionProfileLayerIds({
        repoBindingProfileId: null,
        effectiveDefaultProfileId: null,
        explicitOverrideProfileId: null,
      })
    ).toEqual({ baseProfileId: null, topProfileId: null, topSource: null });
  });
});

describe('formatSessionProfileCounts', () => {
  it('joins the non-zero counts in web order', () => {
    expect(
      formatSessionProfileCounts(
        profile({
          id: 'p',
          name: 'P',
          varCount: 3,
          mcpServerCount: 1,
          skillCount: 2,
          kiloCommandCount: 4,
        })
      )
    ).toBe('3 vars · 1 MCP · 2 skills · 4 cmds');
  });

  it('returns an empty string for an all-zero profile', () => {
    expect(formatSessionProfileCounts(profile({ id: 'p', name: 'P' }))).toBe('');
  });
});

describe('resolveSessionProfilePicker', () => {
  const base = profile({ id: 'repo', name: 'Repo profile', varCount: 1 });
  const fallback = profile({ id: 'default', name: 'Default profile', mcpServerCount: 2 });
  const picked = profile({
    id: 'picked',
    name: 'Picked profile',
    skillCount: 3,
    kiloCommandCount: 1,
  });

  it('shows the effective default with no override and no repo base', () => {
    const state = resolveSessionProfilePicker({
      profiles: [fallback, picked],
      repoBindingProfileId: null,
      effectiveDefaultProfileId: 'default',
      selectedOverrideProfileId: null,
    });

    expect(state.chipName).toBe('Default profile');
    expect(state.chipCounts).toBe('2 MCP');
    expect(state.hasOverride).toBe(false);
    expect(state.topSource).toBe('default');
    expect(state.selectedProfileId).toBe('default');
    expect(state.overrideNeedsAttention).toBe(false);
    expect(state.candidates.map(candidate => candidate.id)).toEqual(['default', 'picked']);
  });

  it('shows the picked override and offers it as selected', () => {
    const state = resolveSessionProfilePicker({
      profiles: [fallback, picked],
      repoBindingProfileId: null,
      effectiveDefaultProfileId: 'default',
      selectedOverrideProfileId: 'picked',
    });

    expect(state.chipName).toBe('Picked profile');
    expect(state.hasOverride).toBe(true);
    expect(state.topSource).toBe('explicit');
    expect(state.selectedProfileId).toBe('picked');
    expect(state.overrideNeedsAttention).toBe(false);
  });

  it('layers the pick on the repo base and excludes the base from candidates', () => {
    const state = resolveSessionProfilePicker({
      profiles: [base, fallback, picked],
      repoBindingProfileId: 'repo',
      effectiveDefaultProfileId: 'default',
      selectedOverrideProfileId: 'picked',
    });

    expect(state.baseProfile?.id).toBe('repo');
    expect(state.topProfile?.id).toBe('picked');
    // vars take the larger layer; MCP/skills/cmds add across the pair. The
    // override replaces the default, so the default's MCP count is not added.
    expect(state.chipCounts).toBe('1 vars · 3 skills · 1 cmds');
    expect(state.candidates.map(candidate => candidate.id)).toEqual(['default', 'picked']);
  });

  it('flags attention and drops the stale id when the override no longer resolves', () => {
    const state = resolveSessionProfilePicker({
      profiles: [fallback],
      repoBindingProfileId: null,
      effectiveDefaultProfileId: 'default',
      selectedOverrideProfileId: 'deleted',
    });

    expect(state.overrideNeedsAttention).toBe(true);
    expect(state.selectedProfileId).toBeNull();
    expect(state.hasOverride).toBe(false);
  });

  it('resolves the empty state: no profiles, no default, no override', () => {
    const state = resolveSessionProfilePicker({
      profiles: [],
      repoBindingProfileId: null,
      effectiveDefaultProfileId: null,
      selectedOverrideProfileId: null,
    });

    expect(state.chipName).toBeNull();
    expect(state.chipCounts).toBe('');
    expect(state.selectedProfileId).toBeNull();
    expect(state.overrideNeedsAttention).toBe(false);
    expect(state.candidates).toEqual([]);
  });
});
