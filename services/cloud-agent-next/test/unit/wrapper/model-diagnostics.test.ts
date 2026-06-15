import { describe, expect, it } from 'vitest';

import { buildModelNotFoundRuntimeDiagnostics } from '../../../wrapper/src/model-diagnostics.js';

describe('buildModelNotFoundRuntimeDiagnostics', () => {
  it('ranks broad fuzzy matches across provider prefixes and slash suffixes', () => {
    const diagnostics = buildModelNotFoundRuntimeDiagnostics('kilo/claude-sonnet-4', [
      'openai/gpt-5.1',
      'anthropic/claude-sonnet-4-20250514',
      'google/gemini-3-pro',
    ]);

    expect(diagnostics).toMatchObject({
      requestedModel: 'kilo/claude-sonnet-4',
      availableModelCount: 3,
      suggestionSource: 'fuzzy',
    });
    expect(diagnostics.suggestedModels[0]).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('falls back to the first five lexicographic model IDs when fuzzy search has no result', () => {
    const diagnostics = buildModelNotFoundRuntimeDiagnostics('kilo/zzzzzz', [
      'vendor/theta',
      'vendor/beta',
      'vendor/epsilon',
      'vendor/delta',
      'vendor/alpha',
      'vendor/gamma',
    ]);

    expect(diagnostics.suggestionSource).toBe('first-five');
    expect(diagnostics.suggestedModels).toEqual([
      'vendor/alpha',
      'vendor/beta',
      'vendor/delta',
      'vendor/epsilon',
      'vendor/gamma',
    ]);
  });

  it('reports no suggestions when the runtime exposes no models', () => {
    const diagnostics = buildModelNotFoundRuntimeDiagnostics('kilo/missing', []);

    expect(diagnostics).toEqual({
      requestedModel: 'kilo/missing',
      availableModelCount: 0,
      availableModels: [],
      suggestedModels: [],
      suggestionSource: 'none',
    });
  });
});
