import { describe, expect, it } from 'vitest';

import { kiloclawConversationEyebrow, kiloclawInstanceSwitcherTitle } from './kiloclaw-display';

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

  it('uses the bot name for instance switcher cards', () => {
    expect(
      kiloclawInstanceSwitcherTitle({
        botName: 'Deploy Bot',
        name: 'Production instance',
        organizationName: 'Engineering',
      })
    ).toBe('Deploy Bot');
  });

  it('falls back when an instance switcher card has no bot name', () => {
    expect(
      kiloclawInstanceSwitcherTitle({
        botName: null,
        name: 'Production instance',
        organizationName: 'Engineering',
      })
    ).toBe('Production instance');

    expect(
      kiloclawInstanceSwitcherTitle({
        botName: null,
        name: null,
        organizationName: 'Engineering',
      })
    ).toBe('Engineering');

    expect(kiloclawInstanceSwitcherTitle(undefined)).toBe('KiloClaw instance');
  });
});
