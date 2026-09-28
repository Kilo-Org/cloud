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
      steps: '',
      temperature: '',
      topP: '',
      variant: '',
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
      steps: '',
      temperature: '',
      topP: '',
      variant: '',
      disabledTools: ['bash'],
    });
  });

  it('seeds the sampling fields and variant from the agent config', () => {
    expect(
      initialAgentFormState(
        agentSource({
          config: {
            model: 'anthropic/claude',
            steps: 50,
            temperature: 0.2,
            top_p: 0.95,
            variant: 'high',
          },
        })
      )
    ).toMatchObject({
      steps: '50',
      temperature: '0.2',
      topP: '0.95',
      variant: 'high',
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
    steps: '',
    temperature: '',
    topP: '',
    variant: '',
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

  it('sends the sampling fields as numbers', () => {
    const payload = buildAgentPayload(
      formState({ model: 'x', steps: '50', temperature: '0.2', topP: '0.95' })
    );
    expect(payload.config.steps).toBe(50);
    expect(payload.config.temperature).toBe(0.2);
    expect(payload.config.top_p).toBe(0.95);
  });

  it('clears the sampling fields when the form is blank', () => {
    const existing = {
      ...agentSource().config,
      steps: 50,
      temperature: 0.2,
      top_p: 0.95,
    };
    const payload = buildAgentPayload(formState({ temperature: '   ' }), existing);
    expect(payload.config.steps).toBeUndefined();
    expect(payload.config.temperature).toBeUndefined();
    expect(payload.config.top_p).toBeUndefined();
  });

  it('drops a zero, negative, or non-numeric step count', () => {
    expect(buildAgentPayload(formState({ steps: '0' })).config.steps).toBeUndefined();
    expect(buildAgentPayload(formState({ steps: '-5' })).config.steps).toBeUndefined();
    expect(buildAgentPayload(formState({ steps: 'abc' })).config.steps).toBeUndefined();
    expect(buildAgentPayload(formState({ steps: '25' })).config.steps).toBe(25);
  });

  it('drops a non-numeric temperature or top_p', () => {
    expect(buildAgentPayload(formState({ temperature: 'hot' })).config.temperature).toBeUndefined();
    expect(buildAgentPayload(formState({ topP: 'x' })).config.top_p).toBeUndefined();
    expect(buildAgentPayload(formState({ temperature: '1.5' })).config.temperature).toBe(1.5);
  });

  it('preserves fields the form does not surface', () => {
    const existing = { ...agentSource().config, hidden: true, color: '#112233' };
    const payload = buildAgentPayload(formState({ steps: '50', temperature: '0.2' }), existing);
    expect(payload.config.hidden).toBe(true);
    expect(payload.config.color).toBe('#112233');
  });

  it('keeps the effort variant when the model is unchanged', () => {
    const existing = { ...agentSource().config, variant: 'high' };
    expect(
      buildAgentPayload(formState({ model: 'anthropic/claude', variant: 'high' }), existing).config
        .variant
    ).toBe('high');
  });

  it('keeps the effort variant when the model changes to one that shares it', () => {
    // The sheet clears `state.variant` only when the typed model does not offer
    // it (`agent-form-sheet.tsx`), so a non-empty variant the form still carries
    // belongs to the new model and must survive the switch.
    const existing = { ...agentSource().config, variant: 'high' };
    expect(
      buildAgentPayload(formState({ model: 'openai/gpt', variant: 'high' }), existing).config
        .variant
    ).toBe('high');
  });

  it('sends a picked variant for a new agent once a model is typed', () => {
    expect(
      buildAgentPayload(formState({ model: 'anthropic/claude', variant: 'low' })).config.variant
    ).toBe('low');
  });

  it('drops the effort variant when the model is cleared or the form carries none', () => {
    const existing = { ...agentSource().config, variant: 'high' };
    expect(
      buildAgentPayload(formState({ model: '', variant: 'high' }), existing).config.variant
    ).toBeUndefined();
    expect(
      buildAgentPayload(formState({ model: 'openai/gpt', variant: '' }), existing).config.variant
    ).toBeUndefined();
  });

  it('omits an empty permission map', () => {
    const payload = buildAgentPayload(formState(), { permission: { bash: 'deny' } });
    expect(payload.config.permission).toBeUndefined();
  });
});
