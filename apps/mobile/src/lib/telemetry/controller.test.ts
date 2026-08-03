import { beforeEach, describe, expect, it } from 'vitest';

import {
  allowsMandatory,
  allowsOptional,
  clearTelemetryDecision,
  currentAccountId,
  currentEpoch,
  currentGeneration,
  resetTelemetryControllerForTests,
  setTelemetryDecision,
} from './controller';

beforeEach(() => {
  resetTelemetryControllerForTests();
});

describe('setTelemetryDecision', () => {
  it('sets a decision that opens both gates when optional is true', () => {
    setTelemetryDecision('acct-1', true);
    expect(allowsMandatory()).toBe(true);
    expect(allowsOptional()).toBe(true);
    expect(currentAccountId()).toBe('acct-1');
  });

  it('sets a decision that opens mandatory only when optional is false', () => {
    setTelemetryDecision('acct-1', false);
    expect(allowsMandatory()).toBe(true);
    expect(allowsOptional()).toBe(false);
    expect(currentAccountId()).toBe('acct-1');
  });
});

describe('gate defaults (fail-closed)', () => {
  it('returns false for both gates before any decision', () => {
    expect(allowsMandatory()).toBe(false);
    expect(allowsOptional()).toBe(false);
  });

  it('returns false for allowsOptional when optional is false', () => {
    setTelemetryDecision('acct-1', false);
    expect(allowsOptional()).toBe(false);
  });
});

describe('generation', () => {
  it('starts at 0', () => {
    expect(currentGeneration()).toBe(0);
  });

  it('increments on an account change', () => {
    setTelemetryDecision('acct-1', true);
    const afterFirst = currentGeneration();

    setTelemetryDecision('acct-2', true);
    expect(currentGeneration()).toBe(afterFirst + 1);
  });

  it('does not increment on the same account', () => {
    setTelemetryDecision('acct-1', true);
    const afterFirst = currentGeneration();

    setTelemetryDecision('acct-1', false);
    expect(currentGeneration()).toBe(afterFirst);
  });

  it('increments when a new account is set after undefined', () => {
    // From undefined to a defined decision is not an account change.
    setTelemetryDecision('acct-1', true);
    const afterFirst = currentGeneration();

    setTelemetryDecision('acct-2', true);
    expect(currentGeneration()).toBe(afterFirst + 1);
  });

  it('increments on clearTelemetryDecision', () => {
    setTelemetryDecision('acct-1', true);
    const afterSet = currentGeneration();

    clearTelemetryDecision();
    expect(currentGeneration()).toBe(afterSet + 1);
  });
});

describe('epoch', () => {
  it('starts at 0', () => {
    expect(currentEpoch()).toBe(0);
  });

  it('increments on every setTelemetryDecision', () => {
    setTelemetryDecision('acct-1', true);
    expect(currentEpoch()).toBe(1);

    setTelemetryDecision('acct-1', false);
    expect(currentEpoch()).toBe(2);

    setTelemetryDecision('acct-2', true);
    expect(currentEpoch()).toBe(3);
  });

  it('increments on same-account optional flips', () => {
    setTelemetryDecision('acct-1', false);
    const epochAfterFalse = currentEpoch();

    setTelemetryDecision('acct-1', true);
    expect(currentEpoch()).toBe(epochAfterFalse + 1);

    setTelemetryDecision('acct-1', false);
    expect(currentEpoch()).toBe(epochAfterFalse + 2);
  });

  it('increments on clearTelemetryDecision', () => {
    setTelemetryDecision('acct-1', true);
    const epochAfterSet = currentEpoch();

    clearTelemetryDecision();
    expect(currentEpoch()).toBe(epochAfterSet + 1);

    clearTelemetryDecision();
    expect(currentEpoch()).toBe(epochAfterSet + 2);
  });
});

describe('clearTelemetryDecision', () => {
  it('closes both gates', () => {
    setTelemetryDecision('acct-1', true);
    expect(allowsMandatory()).toBe(true);
    expect(allowsOptional()).toBe(true);

    clearTelemetryDecision();
    expect(allowsMandatory()).toBe(false);
    expect(allowsOptional()).toBe(false);
  });

  it('clears the account id', () => {
    setTelemetryDecision('acct-1', true);
    expect(currentAccountId()).toBe('acct-1');

    clearTelemetryDecision();
    expect(currentAccountId()).toBeUndefined();
  });

  it('increments both generation and epoch', () => {
    setTelemetryDecision('acct-1', true);
    const genBefore = currentGeneration();
    const epochBefore = currentEpoch();

    clearTelemetryDecision();
    expect(currentGeneration()).toBe(genBefore + 1);
    expect(currentEpoch()).toBe(epochBefore + 1);
  });
});

describe('resetTelemetryControllerForTests', () => {
  it('resets every module-level variable', () => {
    // generation increments only on account change.
    // From undefined to the first decision is not a change.
    setTelemetryDecision('acct-1', true);
    setTelemetryDecision('acct-2', true);
    expect(currentGeneration()).toBeGreaterThan(0);
    expect(currentEpoch()).toBeGreaterThan(0);
    expect(allowsMandatory()).toBe(true);

    resetTelemetryControllerForTests();
    expect(currentGeneration()).toBe(0);
    expect(currentEpoch()).toBe(0);
    expect(allowsMandatory()).toBe(false);
    expect(allowsOptional()).toBe(false);
    expect(currentAccountId()).toBeUndefined();
  });
});

describe('currentAccountId', () => {
  it('returns undefined before any decision', () => {
    expect(currentAccountId()).toBeUndefined();
  });

  it('returns undefined after clear', () => {
    setTelemetryDecision('acct-1', true);
    clearTelemetryDecision();
    expect(currentAccountId()).toBeUndefined();
  });
});
