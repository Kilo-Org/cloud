import { describe, it, expect } from 'vitest';
import { parseModelNotFoundRuntimeDiagnostics } from './runtime-model-diagnostics';

const valid = {
  requestedModel: 'anthropic/claude-sonnet',
  availableModelCount: 2,
  availableModels: ['anthropic/claude-sonnet', 'openai/gpt-4o'],
  suggestedModels: ['anthropic/claude-sonnet'],
  suggestionSource: 'fuzzy',
};

describe('parseModelNotFoundRuntimeDiagnostics', () => {
  it('parses a valid diagnostic', () => {
    const result = parseModelNotFoundRuntimeDiagnostics(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(valid);
    }
  });

  it('rejects non-objects', () => {
    expect(parseModelNotFoundRuntimeDiagnostics('nope').success).toBe(false);
    expect(parseModelNotFoundRuntimeDiagnostics(null).success).toBe(false);
  });

  it('rejects an invalid requested model', () => {
    expect(parseModelNotFoundRuntimeDiagnostics({ ...valid, requestedModel: '' }).success).toBe(
      false
    );
    expect(parseModelNotFoundRuntimeDiagnostics({ ...valid, requestedModel: 42 }).success).toBe(
      false
    );
  });

  it('rejects a count that does not match the list', () => {
    expect(parseModelNotFoundRuntimeDiagnostics({ ...valid, availableModelCount: 1 }).success).toBe(
      false
    );
  });

  it('rejects duplicate model entries', () => {
    expect(
      parseModelNotFoundRuntimeDiagnostics({
        ...valid,
        availableModels: ['anthropic/claude-sonnet', 'anthropic/claude-sonnet'],
      }).success
    ).toBe(false);
  });

  it('rejects a none suggestion source that still lists suggestions', () => {
    expect(
      parseModelNotFoundRuntimeDiagnostics({ ...valid, suggestionSource: 'none' }).success
    ).toBe(false);
  });
});
