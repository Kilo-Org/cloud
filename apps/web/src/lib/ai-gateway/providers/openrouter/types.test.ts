import { describe, expect, it } from '@jest/globals';
import { isFreePromptTrainingAllowed } from './types';

// Used by both the kilo-exclusive free-model data-collection gate and the
// model-experiment routing refusal. Locks the per-request opt-out shapes
// (`provider.data_collection: 'deny'` and `provider.zdr: true`) so a
// regression in this predicate cannot silently allow prompt capture for
// callers who explicitly opted out at the request scope.
describe('isFreePromptTrainingAllowed', () => {
  it('allows when the provider config is undefined', () => {
    expect(isFreePromptTrainingAllowed(undefined)).toBe(true);
  });

  it('allows when no opt-out fields are set', () => {
    expect(isFreePromptTrainingAllowed({})).toBe(true);
  });

  it('allows when data_collection is explicitly "allow"', () => {
    expect(isFreePromptTrainingAllowed({ data_collection: 'allow' })).toBe(true);
  });

  it('refuses when data_collection is "deny"', () => {
    expect(isFreePromptTrainingAllowed({ data_collection: 'deny' })).toBe(false);
  });

  it('refuses when zdr is true', () => {
    expect(isFreePromptTrainingAllowed({ zdr: true })).toBe(false);
  });

  it('refuses when both opt-out fields are set', () => {
    expect(isFreePromptTrainingAllowed({ data_collection: 'deny', zdr: true })).toBe(false);
  });

  it('allows when zdr is explicitly false and no other opt-out is set', () => {
    expect(isFreePromptTrainingAllowed({ zdr: false })).toBe(true);
  });
});
