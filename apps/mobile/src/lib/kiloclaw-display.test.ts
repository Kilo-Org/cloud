import { describe, expect, it } from 'vitest';

import {
  kiloclawConversationEyebrow,
  kiloclawInstanceSwitcherTitle,
  renameKiloClawInstance,
} from './kiloclaw-display';

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

describe('KiloClaw instance rename cache', () => {
  const instances = [
    { organizationId: null, name: 'Personal', sandboxId: 'personal' },
    { organizationId: 'org-1', name: 'Org one', sandboxId: 'org-1' },
    { organizationId: 'org-2', name: 'Org two', sandboxId: 'org-2' },
  ];

  it('renames only the personal instance', () => {
    expect(renameKiloClawInstance(instances, null, 'Renamed personal')).toEqual([
      { organizationId: null, name: 'Renamed personal', sandboxId: 'personal' },
      instances[1],
      instances[2],
    ]);
  });

  it('renames only the matching organization instance', () => {
    expect(renameKiloClawInstance(instances, 'org-1', 'Renamed org')).toEqual([
      instances[0],
      { organizationId: 'org-1', name: 'Renamed org', sandboxId: 'org-1' },
      instances[2],
    ]);
  });
});
