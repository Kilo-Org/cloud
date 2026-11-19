import { createElement, useEffect } from 'react';
import { act } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';
// Static import: the route module is under test, and its `vi.mock`-ed
// dependencies register before this import resolves.
import TriggersRoute from './index';

/**
 * The triggers list route remounts its screen whenever the applied language
 * changes, the same way the profile tab route does. A restored scene can come
 * back stale across an RTL language change's native reload (the reported blank
 * triggers body until the user left and re-entered the screen), so the route
 * keys the screen on `useTranslation`'s `i18n.language`: the same i18next event
 * that re-renders translated copy also remounts the screen, so a stale scene
 * re-paints without a navigation edge.
 *
 * Only the list route carries the key. The create and detail screens hold
 * unsaved form state in their own `useState`, and an in-place language change
 * (the direction stays the same, so no reload runs) would silently discard it.
 * The list holds no such state, so it remounts safely.
 *
 * The remount is made observable through a screen that records its mounts: a
 * `useTranslation` re-render alone would keep the same mounted element.
 */

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ org: 'org-1' }),
}));

let mountedOrganizationId: string | null | undefined = undefined;
// Real mounts, not renders: a plain re-render must keep this flat, or the
// remount assertion below would pass without the key. A `useEffect` with an
// empty dependency array runs once per mounted instance, so a re-render of
// the same element does not bump it while a key swap does.
let mounts = 0;

vi.mock('@/components/cloud-triggers/triggers-list-screen', () => ({
  TriggersListScreen: (props: { organizationId?: string }) => {
    useEffect(() => {
      mounts += 1;
    }, []);
    mountedOrganizationId = props.organizationId ?? null;
    return createElement(
      'TriggersListScreen',
      { organizationId: props.organizationId ?? null },
      `organizationId:${props.organizationId ?? 'none'}`
    );
  },
}));

vi.mock('@/lib/cloud-triggers/trigger-scope', () => ({
  triggerScopeFromParam: (org: string | undefined) => org,
}));

beforeEach(async () => {
  vi.useRealTimers();
  mounts = 0;
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('TriggersRoute language remount', () => {
  it('mounts the list under the deep-linked organization', async () => {
    const { unmount } = await renderWithProviders(createElement(TriggersRoute));

    expect(mounts).toBe(1);
    expect(mountedOrganizationId).toBe('org-1');

    unmount();
  });

  it('remounts the list when the applied language changes', async () => {
    const { unmount } = await renderWithProviders(createElement(TriggersRoute));
    expect(mounts).toBe(1);
    expect(mountedOrganizationId).toBe('org-1');

    // Applying a new language re-renders the route through the real
    // `useTranslation`, and the key swap unmounts the old screen and mounts a
    // fresh one. A plain re-render would keep the same element and leave
    // `mounts` at 1.
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    expect(mounts).toBe(2);

    // The organization scope survives the remount: the fresh scene shows the
    // same deep-linked list, not the personal one.
    expect(mountedOrganizationId).toBe('org-1');

    await act(async () => {
      await i18n.changeLanguage('ja-JP');
    });
    expect(mounts).toBe(3);

    unmount();
  });
});
