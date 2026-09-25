/* eslint-disable @typescript-eslint/no-require-imports -- Load the component after registering Jest mocks. */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as React from 'react';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type * as Provider from './PostHogProvider';

const client = {
  __loaded: true,
  get_distinct_id: jest.fn(() => 'anonymous'),
  init: jest.fn(),
  identify: jest.fn(),
  alias: jest.fn(),
  reloadFeatureFlags: jest.fn(),
  reset: jest.fn(),
};
let session = {
  status: 'authenticated',
  data: { user: { email: 'person@example.com', name: 'Person' }, expires: 'first' },
};
jest.mock('posthog-js', () => ({ __esModule: true, default: client }));
jest.mock('posthog-js/react', () => ({
  usePostHog: () => client,
  PostHogProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('next-auth/react', () => ({ useSession: () => session }));
jest.mock('next/navigation', () => ({
  usePathname: () => null,
  useSearchParams: () => new URLSearchParams(),
}));
const { PostHogProvider } = jest.requireActual<typeof Provider>('./PostHogProvider');

// Use the same DOM dependency as the existing sign-in component tests.
const { parseHTML } = createRequire(__filename)(
  '../../../../node_modules/.pnpm/linkedom@0.18.12/node_modules/linkedom'
) as { parseHTML: (html: string) => { window: Window; document: Document } };
let root: Root;
const keys = ['React', 'window', 'document', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const descriptors = new Map(
  keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
);

beforeEach(() => {
  jest.clearAllMocks();
  const dom = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(dom.window, { location: { pathname: '/' } });
  Object.assign(globalThis, {
    React,
    window: dom.window,
    document: dom.document,
    localStorage: { getItem: () => null },
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  jest.replaceProperty(process, 'env', { ...process.env, NEXT_PUBLIC_POSTHOG_KEY: 'test-key' });
  session = {
    status: 'authenticated',
    data: { user: { email: 'person@example.com', name: 'Person' }, expires: 'first' },
  };
  const container = dom.document.getElementById('root');
  if (!container) throw new Error('Missing test container');
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  jest.restoreAllMocks();
  for (const key of keys) {
    const descriptor = descriptors.get(key);
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const render = () =>
  act(async () => root.render(createElement(PostHogProvider, { children: null })));

describe('PostHog identification', () => {
  it('identifies once without manually aliasing or reloading flags', async () => {
    await render();
    expect(client.identify).toHaveBeenCalledWith('person@example.com', {
      email: 'person@example.com',
      name: 'Person',
    });
    expect(client.alias).not.toHaveBeenCalled();
    expect(client.reloadFeatureFlags).not.toHaveBeenCalled();
  });

  it('does not identify again when NextAuth refreshes an unchanged session', async () => {
    await render();
    session = {
      ...session,
      data: { ...session.data, user: { ...session.data.user }, expires: 'later' },
    };
    await render();
    expect(client.identify).toHaveBeenCalledTimes(1);
  });

  it('updates changed person properties', async () => {
    await render();
    session = {
      ...session,
      data: { ...session.data, user: { ...session.data.user, name: 'Updated' } },
    };
    await render();
    expect(client.identify).toHaveBeenLastCalledWith('person@example.com', {
      email: 'person@example.com',
      name: 'Updated',
    });
    expect(client.identify).toHaveBeenCalledTimes(2);
  });

  it('resets on logout and identifies again after login', async () => {
    await render();
    session = { ...session, status: 'unauthenticated' };
    await render();
    expect(client.reset).toHaveBeenCalledTimes(1);
    session = { ...session, status: 'authenticated' };
    await render();
    expect(client.identify).toHaveBeenCalledTimes(2);
  });
});
