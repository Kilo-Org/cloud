import { describe, expect, it } from 'vitest';

import { type AutoSelectInput, pickAutoSelectedModel } from './auto-select-model';

const efficient = {
  id: 'kilo-auto/efficient',
  name: 'Auto Efficient',
  variants: [],
  isPreferred: false,
};
const claude = {
  id: 'anthropic/claude',
  name: 'Claude',
  variants: ['thinking'],
  isPreferred: true,
};
const gpt = { id: 'openai/gpt', name: 'GPT', variants: [], isPreferred: false };

const base: AutoSelectInput = {
  models: [],
  lastSelected: null,
  stored: {},
  organizationId: undefined,
  orgDefaultModel: undefined,
  isDev: true,
};

describe('pickAutoSelectedModel', () => {
  it('dev, no overrides, efficient in catalog → selects efficient', () => {
    expect(pickAutoSelectedModel({ ...base, models: [claude, efficient, gpt] })).toEqual({
      model: 'kilo-auto/efficient',
      variant: '',
    });
  });

  it('dev, efficient absent → falls back to models[0]', () => {
    expect(pickAutoSelectedModel({ ...base, models: [claude, gpt] })).toEqual({
      model: 'anthropic/claude',
      variant: 'thinking',
    });
  });

  it('dev, matching org default wins over efficient', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        models: [claude, efficient],
        orgDefaultModel: 'anthropic/claude',
      })
    ).toEqual({ model: 'anthropic/claude', variant: 'thinking' });
  });

  it('dev, org default not in catalog → efficient', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        models: [claude, efficient],
        orgDefaultModel: 'gone/model',
      })
    ).toEqual({ model: 'kilo-auto/efficient', variant: '' });
  });

  it('dev, server lastSelected wins over efficient', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        models: [claude, efficient],
        lastSelected: { model: 'anthropic/claude', variant: 'thinking' },
      })
    ).toEqual({ model: 'anthropic/claude', variant: 'thinking' });
  });

  it('dev, local persisted preference wins over efficient', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        models: [gpt, efficient],
        stored: { personal: { model: 'openai/gpt', variant: '' } },
      })
    ).toEqual({ model: 'openai/gpt', variant: '' });
  });

  it('release, efficient in catalog → keeps production fallback models[0]', () => {
    expect(pickAutoSelectedModel({ ...base, isDev: false, models: [claude, efficient] })).toEqual({
      model: 'anthropic/claude',
      variant: 'thinking',
    });
  });

  it('release, matching org default → org default', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        isDev: false,
        models: [claude, efficient],
        orgDefaultModel: 'anthropic/claude',
      })
    ).toEqual({ model: 'anthropic/claude', variant: 'thinking' });
  });

  it('release, org default not in catalog → models[0]', () => {
    expect(
      pickAutoSelectedModel({
        ...base,
        isDev: false,
        models: [claude, efficient],
        orgDefaultModel: 'gone/model',
      })
    ).toEqual({ model: 'anthropic/claude', variant: 'thinking' });
  });

  it('empty catalog → null', () => {
    expect(pickAutoSelectedModel({ ...base, models: [] })).toBeNull();
  });

  it('dev, efficient absent, matching org default → org default wins', () => {
    expect(
      pickAutoSelectedModel({ ...base, models: [claude, gpt], orgDefaultModel: 'openai/gpt' })
    ).toEqual({ model: 'openai/gpt', variant: '' });
  });
});
