import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

/**
 * Pins the Telugu composer attachment refusal. The English entry states a
 * capability limit, and both call sites show the message before any file
 * leaves the device, so the sentence names the inability rather than a
 * finished non-delivery. This file changes no key, placeholder, or plural
 * category.
 */

beforeAll(async () => {
  await i18n.changeLanguage('te');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Telugu composer attachment refusal copy', () => {
  it("states the session's inability to receive files", () => {
    expect(i18n.t('agentChat.composer.cannotReceiveFiles')).toBe(
      'ఈ సెషన్ ఫైళ్లను స్వీకరించలేకపోతోంది. మీ సందేశాన్ని పంపడానికి జోడింపులను తీసివేయండి.'
    );
  });
});
