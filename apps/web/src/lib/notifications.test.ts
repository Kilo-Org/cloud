import { describe, test, expect } from '@jest/globals';
import { isKiloExclusiveFreeModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { normalUnconditionalNotifications, passesLegacyExtensionGate } from './notifications';

describe('normalUnconditionalNotifications', () => {
  test('StepFun free model notification suggests a public free model', () => {
    const notification = normalUnconditionalNotifications.find(
      n => n.id === 'stepfun-step-5-preview-free-oct-8'
    );

    expect(notification?.suggestModelId).toBe('stepfun/step-5-preview-free');
    expect(isKiloExclusiveFreeModel(notification?.suggestModelId ?? '')).toBe(true);
  });
});

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
