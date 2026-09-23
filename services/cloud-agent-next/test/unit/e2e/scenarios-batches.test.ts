import { describe, expect, it } from 'vitest';

import {
  E2E_BATCHES,
  MAX_BATCH_PARALLEL,
  resolveBatch,
  validateScenarioBatches,
  type E2EBatch,
} from '../../e2e/scenarios-batches.js';
import { SHARED_SCENARIOS } from '../../e2e/scenarios-shared.js';

const registryKeys = Object.keys(SHARED_SCENARIOS);

describe('E2E_BATCHES registry partition', () => {
  it('places every real registry scenario exactly once', () => {
    const placed = Object.values(E2E_BATCHES).flatMap(batch => [...batch.scenarios]);

    expect(placed).toHaveLength(registryKeys.length);
    expect(new Set(placed).size).toBe(placed.length);
    expect([...new Set(placed)].sort()).toEqual([...registryKeys].sort());
    expect(validateScenarioBatches(E2E_BATCHES, registryKeys)).toEqual([]);
  });

  it('uses a filesystem- and argv-safe batch-name charset', () => {
    const names = Object.keys(E2E_BATCHES);
    expect(names).toHaveLength(4);
    for (const name of names) {
      expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('gives every batch a non-empty membership and an in-range parallel', () => {
    expect(MAX_BATCH_PARALLEL).toBe(4);
    for (const [name, batch] of Object.entries(E2E_BATCHES)) {
      expect(batch.scenarios.length, `${name} membership`).toBeGreaterThan(0);
      expect(Number.isInteger(batch.parallel), `${name} parallel`).toBe(true);
      expect(batch.parallel).toBeGreaterThanOrEqual(1);
      expect(batch.parallel).toBeLessThanOrEqual(MAX_BATCH_PARALLEL);
    }
  });
});

describe('validateScenarioBatches', () => {
  function batch(scenarios: readonly string[], parallel = 1): E2EBatch {
    return { scenarios, parallel };
  }

  it('reports a scenario that is not in the registry', () => {
    const errors = validateScenarioBatches({ b: batch(['nope']) }, ['a']);
    expect(errors).toContainEqual(expect.stringContaining('unknown scenario "nope"'));
  });

  it('reports a scenario listed in more than one batch', () => {
    const errors = validateScenarioBatches({ b1: batch(['a']), b2: batch(['a']) }, ['a']);
    expect(errors).toContainEqual(expect.stringContaining('"a" is listed in more than one batch'));
  });

  it('reports a registry scenario missing from every batch', () => {
    const errors = validateScenarioBatches({ b: batch(['a']) }, ['a', 'b']);
    expect(errors).toContainEqual(expect.stringContaining('"b" is missing from every batch'));
  });

  it.each([0, MAX_BATCH_PARALLEL + 1, 2.5])(
    'reports parallel %s outside [1, MAX_BATCH_PARALLEL]',
    parallel => {
      const errors = validateScenarioBatches({ b: batch(['a'], parallel) }, ['a']);
      expect(errors).toContainEqual(expect.stringContaining(`parallel ${parallel}`));
    }
  );

  it('returns no errors for a valid synthetic partition', () => {
    const errors = validateScenarioBatches(
      { first: batch(['a', 'b'], 2), second: batch(['c'], 4) },
      ['a', 'b', 'c']
    );
    expect(errors).toEqual([]);
  });
});

describe('resolveBatch', () => {
  it('resolves a known batch and returns its declared membership unchanged', () => {
    expect(resolveBatch('long-question-idle', registryKeys)).toEqual({
      ok: true,
      name: 'long-question-idle',
      scenarios: ['question-idle-resume', 'auth-reject', 'unknown-model'],
      parallel: 2,
    });
  });

  it('rejects a declared member absent from the registry using the shared diagnostic', () => {
    // No silent partial resolution: a registry missing a declared member is an
    // error, and its text comes from the same rule the exhaustive validator
    // uses — resolveBatch does not restate it.
    const registry = ['unknown-model', 'auth-reject'];
    const diagnostic = 'batch "long-question-idle" lists unknown scenario "question-idle-resume"';

    const resolution = resolveBatch('long-question-idle', registry);
    if (resolution === null || resolution.ok) throw new Error('expected a rejection');
    expect(resolution.errors).toEqual([diagnostic]);

    expect(
      validateScenarioBatches({ 'long-question-idle': E2E_BATCHES['long-question-idle'] }, registry)
    ).toEqual([diagnostic]);
  });

  it('returns null for an unknown or inherited batch name', () => {
    expect(resolveBatch('no-such-batch', registryKeys)).toBeNull();
    // `toString` must not pass an own-property lookup and then throw.
    expect(resolveBatch('toString', registryKeys)).toBeNull();
  });
});
