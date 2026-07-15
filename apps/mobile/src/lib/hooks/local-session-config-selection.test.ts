import { describe, expect, it } from 'vitest';

import {
  INITIAL_LOCAL_SESSION_CONFIG_SELECTION,
  reduceLocalSessionConfigSelection,
} from './local-session-config-selection';
import { type LocalRuntimeFence } from './local-runtime-catalog-types';
import { makeCatalog, RUNTIME_A, RUNTIME_B } from './local-runtime-catalog-test-fixtures';

const FENCE_A: LocalRuntimeFence = {
  runtimeId: RUNTIME_A.runtimeId,
  connectionId: RUNTIME_A.connectionId,
};

const FENCE_A_RECONNECTED: LocalRuntimeFence = {
  runtimeId: RUNTIME_A.runtimeId,
  connectionId: 'cli-a-new',
};

const FENCE_B: LocalRuntimeFence = {
  runtimeId: RUNTIME_B.runtimeId,
  connectionId: RUNTIME_B.connectionId,
};

describe('reduceLocalSessionConfigSelection — setFence', () => {
  it('returns the initial state when the action sets a null fence and state is already empty', () => {
    const next = reduceLocalSessionConfigSelection(INITIAL_LOCAL_SESSION_CONFIG_SELECTION, {
      type: 'setFence',
      fence: null,
    });
    expect(next).toBe(INITIAL_LOCAL_SESSION_CONFIG_SELECTION);
  });

  it('clears the existing fence and overrides when the action sets a null fence', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, { type: 'setFence', fence: null });
    expect(next).toEqual({
      selectedFence: null,
      agentOverride: null,
      modelOverride: null,
    });
  });

  it('preserves overrides when the action re-sets the same fence', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, { type: 'setFence', fence: FENCE_A });
    expect(next).toBe(seeded);
  });

  it('clears overrides when the action sets a different fence (reconnect)', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'setFence',
      fence: FENCE_A_RECONNECTED,
    });
    expect(next).toEqual({
      selectedFence: FENCE_A_RECONNECTED,
      agentOverride: null,
      modelOverride: null,
    });
  });

  it('clears overrides when the action sets a completely different fence', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, { type: 'setFence', fence: FENCE_B });
    expect(next).toEqual({
      selectedFence: FENCE_B,
      agentOverride: null,
      modelOverride: null,
    });
  });
});

describe('reduceLocalSessionConfigSelection — selectAgent', () => {
  it('updates the agent and locks the model when the agent pins a model', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: null,
      modelOverride: null,
    };
    const catalog = makeCatalog({
      agents: [
        {
          slug: 'build',
          name: 'Build',
          model: { providerID: 'anthropic', modelID: 'claude-1' },
          variant: 'high',
        },
        { slug: 'plan', name: 'Plan' },
      ],
    });
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'build',
      catalog,
    });
    expect(next.agentOverride).toBe('build');
    expect(next.modelOverride).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'high',
    });
  });

  it('overrides a previous model selection when the new agent pins its own model', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'openai', modelID: 'gpt-1', variant: 'low' },
    };
    const catalog = makeCatalog({
      agents: [
        {
          slug: 'build',
          name: 'Build',
          model: { providerID: 'anthropic', modelID: 'claude-1' },
        },
        { slug: 'plan', name: 'Plan' },
      ],
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          models: [{ id: 'claude-1', name: 'Claude 1', variants: ['low', 'high'] }],
        },
        {
          id: 'openai',
          name: 'OpenAI',
          models: [{ id: 'gpt-1', name: 'GPT 1', variants: ['low'] }],
        },
      ],
    });
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'build',
      catalog,
    });
    expect(next.agentOverride).toBe('build');
    expect(next.modelOverride).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: '',
    });
  });

  it('keeps a compatible model override when switching to an unpinned agent', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'build',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'low' },
    };
    const catalog = makeCatalog({
      agents: [
        { slug: 'build', name: 'Build' },
        { slug: 'plan', name: 'Plan' },
      ],
    });
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'plan',
      catalog,
    });
    expect(next.agentOverride).toBe('plan');
    expect(next.modelOverride).toEqual(seeded.modelOverride);
  });

  it('drops a model override whose model is no longer in the catalog', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'build',
      modelOverride: { providerID: 'openai', modelID: 'gpt-99', variant: 'low' },
    };
    const catalog = makeCatalog({
      agents: [
        { slug: 'build', name: 'Build' },
        { slug: 'plan', name: 'Plan' },
      ],
    });
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'plan',
      catalog,
    });
    expect(next.agentOverride).toBe('plan');
    expect(next.modelOverride).toBeNull();
  });

  it('falls back to the first variant of a model when the override variant is no longer present', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'build',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'gone' },
    };
    const catalog = makeCatalog({
      agents: [
        { slug: 'build', name: 'Build' },
        { slug: 'plan', name: 'Plan' },
      ],
    });
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'plan',
      catalog,
    });
    expect(next.modelOverride).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'low',
    });
  });

  it('drops the agent override when the slug is unknown (defensive)', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'low' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectAgent',
      slug: 'ghost',
      catalog: makeCatalog(),
    });
    expect(next.agentOverride).toBeNull();
    expect(next.modelOverride).toBeNull();
  });
});

describe('reduceLocalSessionConfigSelection — selectModel', () => {
  it('updates the model override without changing the agent override', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'low' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, {
      type: 'selectModel',
      selection: { providerID: 'anthropic', modelID: 'claude-1', variant: 'high' },
    });
    expect(next.agentOverride).toBe('plan');
    expect(next.modelOverride).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-1',
      variant: 'high',
    });
  });
});

describe('reduceLocalSessionConfigSelection — resetOverrides', () => {
  it('clears both overrides without touching the fence', () => {
    const seeded = {
      selectedFence: FENCE_A,
      agentOverride: 'plan',
      modelOverride: { providerID: 'anthropic', modelID: 'claude-1', variant: 'low' },
    };
    const next = reduceLocalSessionConfigSelection(seeded, { type: 'resetOverrides' });
    expect(next).toEqual({ selectedFence: FENCE_A, agentOverride: null, modelOverride: null });
  });

  it('is a no-op when both overrides are already null', () => {
    const seeded = { selectedFence: FENCE_A, agentOverride: null, modelOverride: null };
    const next = reduceLocalSessionConfigSelection(seeded, { type: 'resetOverrides' });
    expect(next).toBe(seeded);
  });
});
