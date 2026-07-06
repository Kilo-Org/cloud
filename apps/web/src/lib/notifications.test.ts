import { describe, test, expect } from '@jest/globals';
import { passesExtensionVersionGate } from './notifications';

describe('passesExtensionVersionGate', () => {
  test('always shows notifications without a version gate', () => {
    expect(passesExtensionVersionGate({}, undefined)).toBe(true);
    expect(passesExtensionVersionGate({}, 7.001)).toBe(true);
    expect(passesExtensionVersionGate({ extensionVersionBelow: undefined }, 4)).toBe(true);
  });

  test('treats unknown/absent version as an old client and shows it', () => {
    // Legacy extension sends no version headers → undefined → shown.
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, undefined)).toBe(true);
  });

  test('hides when the known client version is at or above the threshold', () => {
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 7)).toBe(false);
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 7.001)).toBe(false);
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 8)).toBe(false);
  });

  test('shows when the known client version is below the threshold', () => {
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 6.099009)).toBe(true);
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 4.082)).toBe(true);
    expect(passesExtensionVersionGate({ extensionVersionBelow: 7 }, 0)).toBe(true);
  });
});
