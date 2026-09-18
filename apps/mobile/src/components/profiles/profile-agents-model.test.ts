import { describe, expect, it } from 'vitest';

import {
  type AgentFormState,
  type AgentPermissionMap,
  agentRows,
  type AgentSource,
  buildAgentPayload,
  initialAgentFormState,
  mergePermissions,
  readDisabledTools,
  validateAgentForm,
} from '@/components/profiles/profile-agents-model';

function agentSource(overrides: Partial<AgentSource> = {}): AgentSource {
  return {
    id: 'agent-1',
    slug: 'reviewer',
    name: 'Reviewer',
    config: {
      description: 'Reviews code',
      mode: 'primary',
      model: 'anthropic/claude',
      prompt: 'You review',
      permission: { bash: 'deny', read: 'allow' },
    },
    ...overrides,
  };
}

describe('agentRows', () => {
  it('projects the row fields with primary as the default visibility', () => {
    expect(agentRows([agentSource(), agentSource({ config: {} })])).toEqual([
      {
        id: 'agent-1',
        slug: 'reviewer',
        name: 'Reviewer',
        visibility: 'primary',
        description: 'Reviews code',
        model: 'anthropic/claude',
      },
      {
        id: 'agent-1',
        slug: 'reviewer',
        name: 'Reviewer',
        visibility: 'primary',
        description: '',
        model: '',
      },
    ]);
  });
});

describe('readDisabledTools', () => {
  it('returns only the tools with a simple deny rule', () => {
    expect(readDisabledTools({ bash: 'deny', read: 'allow', glob: { '**/*.ts': 'deny' } })).toEqual(
      ['bash']
    );
  });

  it('returns nothing for a non-object permission', () => {
    expect(readDisabledTools(undefined)).toEqual([]);
    expect(readDisabledTools(null)).toEqual([]);
    expect(readDisabledTools('allow')).toEqual([]);
  });
});

describe('mergePermissions', () => {
  it('writes deny for a disabled tool and clears every other simple rule', () => {
    expect(mergePermissions({ bash: 'deny', read: 'allow' }, ['read'])).toEqual({ read: 'deny' });
    expect(mergePermissions({ bash: 'deny', read: 'deny' }, [])).toBeUndefined();
  });

  it('preserves a per-pattern rule when a tool is re-enabled', () => {
    const perPattern: AgentPermissionMap = { glob: { '**/*.ts': 'deny' } };
    expect(mergePermissions(perPattern, [])).toEqual(perPattern);
  });

  it('returns undefined when nothing is left', () => {
    expect(mergePermissions(undefined, [])).toBeUndefined();
    expect(mergePermissions({ bash: 'deny' }, [])).toBeUndefined();
  });
});

describe('initialAgentFormState', () => {
  it('seeds blank defaults for an add', () => {
    expect(initialAgentFormState()).toEqual({
      slug: '',
      name: '',
      description: '',
      prompt: '',
      visibility: 'primary',
      model: '',
      disabledTools: [],
    });
  });

  it('seeds an agent with its config and denied tools', () => {
    expect(initialAgentFormState(agentSource())).toEqual({
      slug: 'reviewer',
      name: 'Reviewer',
      description: 'Reviews code',
      prompt: 'You review',
      visibility: 'primary',
      model: 'anthropic/claude',
      disabledTools: ['bash'],
    });
  });
});

function formState(overrides: Partial<AgentFormState> = {}): AgentFormState {
  return {
    slug: 'reviewer',
    name: 'Reviewer',
    description: '',
    prompt: '',
    visibility: 'primary',
    model: '',
    disabledTools: [],
    ...overrides,
  };
}

describe('validateAgentForm', () => {
  it('requires a slug', () => {
    expect(validateAgentForm(formState({ slug: '  ' }))).toBe('slug-required');
  });

  it('refuses a slug outside the server pattern', () => {
    expect(validateAgentForm(formState({ slug: 'Bad Slug' }))).toBe('slug-invalid');
    expect(validateAgentForm(formState({ slug: '1agent' }))).toBe('slug-invalid');
  });

  it('refuses a slug reserved by a built-in agent', () => {
    expect(validateAgentForm(formState({ slug: 'code' }))).toBe('slug-conflict');
  });

  it('requires a display name', () => {
    expect(validateAgentForm(formState({ name: ' ' }))).toBe('name-required');
  });

  it('accepts a valid agent', () => {
    expect(validateAgentForm(formState())).toBeNull();
  });
});

describe('buildAgentPayload', () => {
  it('builds the payload and merges the tool toggles', () => {
    expect(
      buildAgentPayload(
        formState({
          name: 'Reviewer',
          description: 'Reviews',
          prompt: 'You review',
          model: 'x',
          disabledTools: ['bash'],
        }),
        agentSource().config
      )
    ).toEqual({
      slug: 'reviewer',
      name: 'Reviewer',
      config: {
        description: 'Reviews',
        mode: 'primary',
        model: 'x',
        prompt: 'You review',
        permission: { bash: 'deny' },
      },
    });
  });

  it('preserves fields the form does not surface', () => {
    const existing = {
      ...agentSource().config,
      temperature: 0.2,
      steps: 50,
      hidden: true,
    };
    const payload = buildAgentPayload(formState(), existing);
    expect(payload.config.temperature).toBe(0.2);
    expect(payload.config.steps).toBe(50);
    expect(payload.config.hidden).toBe(true);
  });

  it('keeps the effort variant when the model is unchanged', () => {
    const existing = { ...agentSource().config, variant: 'high' };
    expect(
      buildAgentPayload(formState({ model: 'anthropic/claude' }), existing).config.variant
    ).toBe('high');
  });

  it('drops the effort variant when the model is cleared or changed', () => {
    const existing = { ...agentSource().config, variant: 'high' };
    expect(buildAgentPayload(formState({ model: '' }), existing).config.variant).toBeUndefined();
    expect(
      buildAgentPayload(formState({ model: 'openai/gpt' }), existing).config.variant
    ).toBeUndefined();
  });

  it('omits an empty permission map', () => {
    const payload = buildAgentPayload(formState(), { permission: { bash: 'deny' } });
    expect(payload.config.permission).toBeUndefined();
  });
});
