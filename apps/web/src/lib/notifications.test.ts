import { describe, test, expect } from '@jest/globals';
import { passesLegacyExtensionGate } from './notifications';

describe('passesLegacyExtensionGate', () => {
  test('always shows notifications not gated to the legacy extension', () => {
    expect(passesLegacyExtensionGate({}, false)).toBe(true);
    expect(passesLegacyExtensionGate({}, true)).toBe(true);
    expect(passesLegacyExtensionGate({ showOnlyOnLegacyExtension: false }, false)).toBe(true);
  });

  test('shows legacy-gated notifications only to the legacy extension', () => {
    expect(passesLegacyExtensionGate({ showOnlyOnLegacyExtension: true }, true)).toBe(true);
    expect(passesLegacyExtensionGate({ showOnlyOnLegacyExtension: true }, false)).toBe(false);
  });
});
