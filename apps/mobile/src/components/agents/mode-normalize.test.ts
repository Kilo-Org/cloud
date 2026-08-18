import { describe, expect, it } from 'vitest';

import {
  customModeOptionsFromProfileAgents,
  customModeOptionsFromRuntimeAgents,
  dedupeCustomModeOptions,
  ensureSelectedCustomOption,
  lockedModelOption,
  type ModeOption,
  normalizeAgentMode,
  resolvePinnedAgentModel,
  visibleProfileAgents,
} from '@/components/agents/mode-normalize';

describe('normalizeAgentMode', () => {
  it('aliases build to code', () => {
    expect(normalizeAgentMode('build')).toBe('code');
  });

  it('aliases architect to plan', () => {
    expect(normalizeAgentMode('architect')).toBe('plan');
  });

  it.each(['code', 'plan', 'debug', 'orchestrator', 'ask'])('keeps built-in %s', mode => {
    expect(normalizeAgentMode(mode)).toBe(mode);
  });

  it('keeps an unknown custom slug', () => {
    expect(normalizeAgentMode('reviewer')).toBe('reviewer');
  });

  it.each([null, undefined, ''])('maps %s to code', mode => {
    expect(normalizeAgentMode(mode)).toBe('code');
  });
});

describe('dedupeCustomModeOptions', () => {
  it('drops a built-in collision', () => {
    const custom: ModeOption[] = [
      { value: 'code', label: 'My Code', description: '' },
      { value: 'reviewer', label: 'Reviewer', description: '' },
    ];
    expect(dedupeCustomModeOptions(custom)).toEqual([
      { value: 'reviewer', label: 'Reviewer', description: '' },
    ]);
  });

  it('keeps non-built-in options unchanged', () => {
    const custom: ModeOption[] = [
      { value: 'reviewer', label: 'Reviewer', description: 'Review the change' },
    ];
    expect(dedupeCustomModeOptions(custom)).toEqual(custom);
  });
});

describe('visibleProfileAgents', () => {
  const base = {
    slug: 's',
    name: 'S',
    config: {},
  };

  it('keeps a visible primary agent', () => {
    expect(visibleProfileAgents([base])).toHaveLength(1);
  });

  it('drops a disabled agent', () => {
    const agent = { ...base, config: { disable: true } };
    expect(visibleProfileAgents([agent])).toHaveLength(0);
  });

  it('drops a hidden agent', () => {
    const agent = { ...base, config: { hidden: true } };
    expect(visibleProfileAgents([agent])).toHaveLength(0);
  });

  it('drops a subagent', () => {
    const agent = { ...base, config: { mode: 'subagent' } };
    expect(visibleProfileAgents([agent])).toHaveLength(0);
  });
});

describe('customModeOptionsFromProfileAgents', () => {
  it('maps slug, name, and description', () => {
    const agents = [
      { slug: 'reviewer', name: 'Reviewer', config: { description: 'Review the change' } },
    ];
    expect(customModeOptionsFromProfileAgents(agents)).toEqual([
      { value: 'reviewer', label: 'Reviewer', description: 'Review the change' },
    ]);
  });

  it('falls back to an empty description', () => {
    const agents = [{ slug: 'reviewer', name: 'Reviewer', config: {} }];
    expect(customModeOptionsFromProfileAgents(agents)).toEqual([
      { value: 'reviewer', label: 'Reviewer', description: '' },
    ]);
  });
});

describe('customModeOptionsFromRuntimeAgents', () => {
  it('maps slug and name with an empty description', () => {
    const runtimeAgents = [{ slug: 'reviewer', name: 'Reviewer' }];
    expect(customModeOptionsFromRuntimeAgents(runtimeAgents)).toEqual([
      { value: 'reviewer', label: 'Reviewer', description: '' },
    ]);
  });

  it('returns empty for a missing list', () => {
    expect(customModeOptionsFromRuntimeAgents(undefined)).toEqual([]);
  });

  it('returns empty for an empty list', () => {
    expect(customModeOptionsFromRuntimeAgents([])).toEqual([]);
  });
});

describe('ensureSelectedCustomOption', () => {
  it('appends the selected unknown slug once', () => {
    const custom: ModeOption[] = [];
    expect(ensureSelectedCustomOption(custom, 'reviewer')).toEqual([
      { value: 'reviewer', label: 'reviewer', description: '' },
    ]);
  });

  it('does not append a built-in slug', () => {
    expect(ensureSelectedCustomOption([], 'code')).toEqual([]);
  });

  it('does not append an already-present slug', () => {
    const custom: ModeOption[] = [{ value: 'reviewer', label: 'Reviewer', description: '' }];
    expect(ensureSelectedCustomOption(custom, 'reviewer')).toHaveLength(1);
  });
});

describe('resolvePinnedAgentModel', () => {
  it('returns model and variant from a profile agent pin', () => {
    const profileAgents = [
      {
        slug: 'locked-bot',
        name: 'Locked Bot',
        config: { model: 'gpt-5', variant: 'fast' },
      },
    ];
    expect(resolvePinnedAgentModel({ slug: 'locked-bot', profileAgents })).toEqual({
      model: 'gpt-5',
      variant: 'fast',
      agentName: 'Locked Bot',
    });
  });

  it('omits variant when the agent pins no model', () => {
    const profileAgents = [{ slug: 'plain', name: 'Plain', config: { variant: 'fast' } }];
    expect(resolvePinnedAgentModel({ slug: 'plain', profileAgents })).toEqual({
      agentName: 'Plain',
    });
  });

  it('reads model and variant from runtimeAgents', () => {
    const runtimeAgents = [
      { slug: 'locked-bot', name: 'Locked Bot', model: 'gpt-5', variant: 'fast' },
    ];
    expect(resolvePinnedAgentModel({ slug: 'locked-bot', runtimeAgents })).toEqual({
      model: 'gpt-5',
      variant: 'fast',
      agentName: 'Locked Bot',
    });
  });

  it('returns empty when no agent matches', () => {
    expect(
      resolvePinnedAgentModel({ slug: 'missing', profileAgents: [], runtimeAgents: [] })
    ).toEqual({});
  });
});

describe('lockedModelOption', () => {
  it('builds a SessionModelOption-compatible object with a variant', () => {
    expect(lockedModelOption({ model: 'gpt-5', variant: 'fast' })).toEqual({
      id: 'gpt-5',
      name: 'gpt-5',
      displayId: 'gpt-5',
      variants: ['fast'],
      isPreferred: false,
      showGatewayMetadata: true,
    });
  });

  it('builds an option with no variants when no variant is pinned', () => {
    expect(lockedModelOption({ model: 'gpt-5' })).toEqual({
      id: 'gpt-5',
      name: 'gpt-5',
      displayId: 'gpt-5',
      variants: [],
      isPreferred: false,
      showGatewayMetadata: true,
    });
  });
});
