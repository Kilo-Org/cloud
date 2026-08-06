import { describe, test, expect } from '@jest/globals';
import { hasDeprecatedAutoModel, passesLegacyExtensionGate } from './notifications';

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

describe('hasDeprecatedAutoModel', () => {
  test('matches Auto Balanced among all models used by a user', () => {
    expect(
      hasDeprecatedAutoModel(['kilo-auto/frontier', 'kilo-auto/balanced', 'kilo-auto/efficient'])
    ).toBe(true);
  });

  test('does not treat other Auto models as deprecated', () => {
    expect(hasDeprecatedAutoModel(['kilo-auto/frontier', 'kilo-auto/efficient'])).toBe(false);
  });
});
