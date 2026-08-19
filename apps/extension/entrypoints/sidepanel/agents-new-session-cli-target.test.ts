import { describe, expect, it, vi } from 'vitest';

import { CLI_MODEL_ID } from '@kilocode/cloud-agent-sdk';

import { buildCreateRemoteSessionInput } from './agents-new-session';

/* eslint-disable jest/no-untyped-mock-factory, vitest/prefer-import-in-mock -- WXT virtual module has no importable runtime type in Vitest. */
// Agents-new-session transitively imports the WXT '#imports' virtual module.
// Stub it so the graph loads under Vitest.
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() }, tabs: { query: vi.fn() } },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    watch: vi.fn(() => () => {
      /* No-op unwatch */
    }),
  },
}));

describe('buildCreateRemoteSessionInput helper', () => {
  it('carries the picked model as a kilo model ref', () => {
    const input = buildCreateRemoteSessionInput({
      organizationId: null,
      selectedModel: 'anthropic/claude-sonnet-4.5',
      selectedVariant: '',
    });
    expect(input).toStrictEqual({
      model: { modelID: 'anthropic/claude-sonnet-4.5', providerID: 'kilo' },
    });
  });

  it('adds the variant when one is picked', () => {
    const input = buildCreateRemoteSessionInput({
      organizationId: null,
      selectedModel: 'gpt-5',
      selectedVariant: 'xhigh',
    });
    expect(input.model).toStrictEqual({
      modelID: 'gpt-5',
      providerID: 'kilo',
      variant: 'xhigh',
    });
  });

  it('omits the model for the CLI default, so the CLI keeps its own model', () => {
    const input = buildCreateRemoteSessionInput({
      organizationId: null,
      selectedModel: CLI_MODEL_ID,
      selectedVariant: '',
    });
    expect(input).toStrictEqual({});
  });

  it('omits the model before the catalog loads', () => {
    const input = buildCreateRemoteSessionInput({
      organizationId: null,
      selectedModel: '',
      selectedVariant: 'high',
    });
    expect(input).toStrictEqual({});
  });

  it('adds orgId for an organization target', () => {
    const input = buildCreateRemoteSessionInput({
      organizationId: 'org-42',
      selectedModel: 'gpt-5',
      selectedVariant: '',
    });
    expect(input.orgId).toBe('org-42');
  });

  it('omits orgId for a personal target', () => {
    expect(
      buildCreateRemoteSessionInput({
        organizationId: undefined,
        selectedModel: CLI_MODEL_ID,
        selectedVariant: '',
      })
    ).not.toHaveProperty('orgId');
  });
});
