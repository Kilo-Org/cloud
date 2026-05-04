import { describe, expect, it } from 'vitest';

import { kiloclawConversationEyebrow } from './kiloclaw-display';

describe('KiloClaw display labels', () => {
  it('uses the bot name above a conversation title', () => {
    expect(
      kiloclawConversationEyebrow({
        botName: 'Helper Bot',
        name: 'Production instance',
        organizationName: 'Engineering',
      })
    ).toBe('Helper Bot');
  });

  it('falls back when the conversation instance has no bot name', () => {
    expect(
      kiloclawConversationEyebrow({
        botName: null,
        name: 'Production instance',
        organizationName: 'Engineering',
      })
    ).toBe('Production instance');

    expect(
      kiloclawConversationEyebrow({
        botName: null,
        name: null,
        organizationName: 'Engineering',
      })
    ).toBe('Engineering');

    expect(kiloclawConversationEyebrow(undefined)).toBe('KiloClaw');
  });
});
