import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OverviewTab } from './OverviewTab';

Object.assign(globalThis, { React });

type Props = ComponentProps<typeof OverviewTab>;

function renderOverview(lastUsedAt: string | null) {
  return renderToStaticMarkup(
    createElement(OverviewTab, {
      profile: {
        id: 'profile-1',
        name: 'My Profile',
        description: null,
        isDefault: false,
        createdAt: '2026-04-29T00:00:00.000Z',
        updatedAt: '2026-04-29T00:00:00.000Z',
        lastUsedAt,
        vars: [],
        commands: [],
        mcpServers: [],
        skills: [],
        agents: [],
        kiloCommands: [],
        instructions: [],
      },
      ownerType: 'user',
      isEffectiveDefault: false,
      mutations: {} as Props['mutations'],
      onDelete: () => {},
      isDeleting: false,
      readOnly: true,
    })
  );
}

describe('OverviewTab last used', () => {
  afterEach(() => jest.useRealTimers());

  it('shows relative usage time and an exact timestamp', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-29T02:00:00.000Z'));

    const markup = renderOverview('2026-04-29T00:00:00.000Z');

    expect(markup).toContain('Last used');
    expect(markup).toContain('2 hours ago');
    expect(markup).toContain('dateTime="2026-04-29T00:00:00.000Z"');
    expect(markup).toContain(`title="${new Date('2026-04-29T00:00:00.000Z').toLocaleString()}"`);
    expect(markup).not.toContain('No recorded usage');
  });

  it('does not imply an unused profile when usage history is unavailable', () => {
    const markup = renderOverview(null);

    expect(markup).toContain('No recorded usage');
    expect(markup).toContain('Older sessions may not be recorded.');
    expect(markup).not.toContain('<time');
  });
});
