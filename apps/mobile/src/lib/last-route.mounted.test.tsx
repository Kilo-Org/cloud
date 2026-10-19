import { createElement, useState } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _hydrateLastRouteForTests,
  _resetLastRouteForTests,
  _setSecureStoreForTests,
  clearLastRoute,
  consumeLastRouteForRepair,
  getLastRoute,
  getLastRouteSnapshot,
} from './last-route';
import { useRecordLastRoute } from './hooks/use-record-last-route';

const routerState = vi.hoisted(() => ({
  pathname: '/agent-chat/ses_gone',
  segments: ['(app)', 'agent-chat', 'ses_gone'] as readonly string[],
}));

vi.mock('expo-router', () => ({
  usePathname: () => routerState.pathname,
  useSegments: () => routerState.segments,
}));

const store = new Map<string, string>();
const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
};

const probeRerender = vi.hoisted(() => ({ trigger: null as null | (() => void) }));

function Probe({ userId }: { userId: string | undefined }): null {
  const [, force] = useState(0);
  probeRerender.trigger = () => {
    force(value => value + 1);
  };
  useRecordLastRoute({ userId });
  return null;
}

function rerenderProbe(): void {
  probeRerender.trigger?.();
}

// The layout's repair consumes (and latches) before recording opens; the probe
// models that ordering.
async function mountProbe(userId: string | undefined): Promise<void> {
  consumeLastRouteForRepair(userId ?? null);
  await act(async () => {
    TestRenderer.create(createElement(Probe, { userId }));
    await Promise.resolve();
  });
}

beforeEach(() => {
  store.clear();
  routerState.pathname = '/agent-chat/ses_gone';
  routerState.segments = ['(app)', 'agent-chat', 'ses_gone'];
  _resetLastRouteForTests();
  _setSecureStoreForTests(secureStoreMock);
});

describe('useRecordLastRoute (mounted)', () => {
  it('records the focused in-app route for the account', async () => {
    await mountProbe('u1');

    expect(getLastRouteSnapshot()?.href).toBe('/(app)/agent-chat/ses_gone');
    expect(getLastRoute('u1')).toBe('/(app)/agent-chat/ses_gone');
  });

  it('records nothing while the account is unknown', async () => {
    await mountProbe(undefined);

    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('does not record gate routes', async () => {
    routerState.pathname = '/consent';
    routerState.segments = ['(app)', 'consent'];
    await mountProbe('u1');

    expect(getLastRouteSnapshot()).toBeNull();
  });

  it('a navigation commit replaces the record with the new path', async () => {
    await mountProbe('u1');
    expect(getLastRouteSnapshot()?.href).toBe('/(app)/agent-chat/ses_gone');

    routerState.pathname = '/(app)/(tabs)/(3_profile)/profiles/p1/variables';
    routerState.segments = ['(app)', '(tabs)', '(3_profile)', 'profiles', 'p1', 'variables'];
    rerenderProbe();
    await act(async () => {
      await Promise.resolve();
    });

    expect(getLastRouteSnapshot()?.href).toBe('/(app)/(tabs)/(3_profile)/profiles/p1/variables');
  });

  it('the record reaches the SecureStore mirror', async () => {
    await mountProbe('u1');
    await _hydrateLastRouteForTests();

    // A fresh read from the mirror reproduces the same route for the account.
    expect(getLastRoute('u1')).toBe('/(app)/agent-chat/ses_gone');
  });
});

// Record-and-clear round trip proves the recorder never fights an explicit
// sign-out clear that lands between commits.
describe('useRecordLastRoute with an explicit clear (mounted)', () => {
  it('a clear between commits keeps the record dropped until the next commit', async () => {
    await mountProbe('u1');
    expect(getLastRouteSnapshot()?.href).toBe('/(app)/agent-chat/ses_gone');

    clearLastRoute();
    expect(getLastRouteSnapshot()).toBeNull();

    routerState.pathname = '/(app)/(tabs)/(0_home)';
    routerState.segments = ['(app)', '(tabs)', '(0_home)'];
    rerenderProbe();
    await act(async () => {
      await Promise.resolve();
    });
    expect(getLastRouteSnapshot()?.href).toBe('/(app)/(tabs)/(0_home)');
  });
});
