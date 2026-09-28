/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Jest node-environment mocks must be registered before loading the component. */
// The device-authorization page opens in the browser on a phone, where the
// card can be narrower than the identity row's inline minimum (avatar + name +
// Sign out). The row has to reflow there: without it the name and email are
// crushed out of the card and Sign out draws past the card's edge.
import { jest } from '@jest/globals';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DeviceAuthClient as DeviceAuthClientType } from '@/app/device-auth/DeviceAuthClient';

jest.mock('next-auth/react', () => ({ signOut: jest.fn(async () => undefined) }));

// The jest transform compiles JSX with the classic runtime
// (`React.createElement`), while the app compiles it with the automatic one, so
// a component that does not import React looks up this global when the suite
// renders it. The component below is required after this line for that reason.
(globalThis as { React?: unknown }).React = require('react');

const { DeviceAuthClient } = require('@/app/device-auth/DeviceAuthClient') as {
  DeviceAuthClient: typeof DeviceAuthClientType;
};

/** The identity row is the only element painted on the muted surface. */
const IDENTITY_ROW_MARKER = 'bg-muted/40';

function renderDeviceAuth(): string {
  return renderToStaticMarkup(
    createElement(DeviceAuthClient, {
      code: 'ABCD-1234',
      viewerToken: 'viewer-token',
      isAppMode: true,
      user: { name: 'Ada Lovelace', email: 'ada@kilo.ai', imageUrl: '' },
    })
  );
}

function classesOfOpeningTag(html: string, marker: string): string[] {
  const tag = html.match(new RegExp(`<[a-z]+ class="[^"]*${marker}[^"]*"[^>]*>`))?.[0];
  if (!tag) {
    throw new Error(`no element carries ${marker}`);
  }
  const value = tag.match(/class="([^"]*)"/)?.[1] ?? '';
  return value.split(/\s+/).filter(Boolean);
}

function classesOfButton(html: string, label: string): string[] {
  const button = (html.match(/<button[\s\S]*?<\/button>/g) ?? []).find(candidate =>
    candidate.includes(label)
  );
  if (!button) {
    throw new Error(`no button contains ${label}`);
  }
  const value = button.match(/class="([^"]*)"/)?.[1] ?? '';
  return value.split(/\s+/).filter(Boolean);
}

describe('device-auth identity row at narrow widths', () => {
  it('stacks until the viewport has room for one line', () => {
    const row = classesOfOpeningTag(renderDeviceAuth(), IDENTITY_ROW_MARKER);

    expect(row).toContain('flex-col');
    expect(row).toContain('sm:flex-row');
    expect(row).toContain('sm:items-center');
    expect(row).toContain('sm:justify-between');
  });

  it('keeps Sign out on its own line while the row is stacked', () => {
    const signOut = classesOfButton(renderDeviceAuth(), 'Sign out');

    expect(signOut).toContain('self-start');
    expect(signOut).toContain('sm:self-auto');
    expect(signOut).toContain('shrink-0');
  });

  it('renders the identity the row has to keep readable', () => {
    const html = renderDeviceAuth();

    expect(html).toContain('Signed in as');
    expect(html).toContain('Ada Lovelace');
    expect(html).toContain('ada@kilo.ai');
  });
});
