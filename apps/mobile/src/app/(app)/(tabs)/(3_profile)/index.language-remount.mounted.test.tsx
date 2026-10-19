import { createElement } from 'react';
import { act } from '@/test/renderer';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The mock harness is imported before any product module so its `vi.mock`
// calls register before the modules under test are loaded.
import {
  authState,
  findConfigureRows,
  flushInteractions,
  interactionState,
  keys,
  nodeCountWithChildren,
  organizationsQueryFn,
  providersQueryFn,
} from '@/components/profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { createTestQueryClient, renderWithProviders, waitFor } from '@/test/render-with-providers';
// Static import: the route module is under test, and its `vi.mock`-ed
// dependencies register before this import resolves.
import ProfileRoute from '@/app/(app)/(tabs)/(3_profile)/index';

/**
 * The Profile tab route remounts its screen whenever the applied language
 * changes. A tab scene can come back stale across an RTL language change's
 * native reload (the reported blank Profile until the user left and re-entered
 * the tab), so the route keys the screen on `useTranslation`'s `i18n.language`:
 * the same i18next event that re-renders translated content also remounts the
 * screen, so a stale scene re-paints without a navigation edge.
 */

beforeEach(async () => {
  vi.useRealTimers();
  providersQueryFn.mockReset();
  organizationsQueryFn.mockReset();
  authState.token = 'token-1';
  interactionState.storedCallback = undefined;
  interactionState.cancel.mockReset();
  providersQueryFn.mockResolvedValue({
    providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
  });
  organizationsQueryFn.mockResolvedValue([]);
  if (i18n.language !== 'en') {
    await i18n.changeLanguage('en');
  }
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});

describe('ProfileRoute language remount', () => {
  it('renders the profile under the active language', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ProfileRoute));

    flushInteractions();
    await waitFor(() => findConfigureRows(renderer.root, 'GitHub').length === 1);
    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');

    unmount();
  });

  it('remounts the screen when the applied language changes', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ProfileRoute));

    flushInteractions();
    await waitFor(() => findConfigureRows(renderer.root, 'GitHub').length === 1);
    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');

    // Applying a new language re-renders the route through `useTranslation`
    // and the key swap unmounts the old screen and mounts a fresh one. The
    // remount is made observable through the interaction deferral: the fresh
    // mount re-runs `useAfterInteractions`, so a cleared captured callback is
    // registered again — `ProfileScreen`'s own `useTranslation` alone would
    // re-render copy without any of that.
    organizationsQueryFn.mockReset();
    organizationsQueryFn.mockResolvedValue([]);
    interactionState.storedCallback = undefined;
    interactionState.cancel.mockClear();
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    // The fresh mount captured a new interaction callback and the old
    // screen's handle was cancelled on unmount.
    expect(interactionState.storedCallback).toBeTypeOf('function');
    expect(interactionState.cancel).toHaveBeenCalled();

    flushInteractions();
    await waitFor(() => nodeCountWithChildren(renderer.root, 'Text', 'الوكلاء') === 1);

    // Section headers read from the Arabic resource, proving the fresh mount
    // re-rendered under the applied language.
    expect(nodeCountWithChildren(renderer.root, 'Text', 'المراجعات')).toBe(1);
    expect(nodeCountWithChildren(renderer.root, 'Text', 'التطبيق')).toBe(1);

    unmount();
  });

  it('keeps a seeded cache across the remount so the fresh scene paints data', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(keys.providers, {
      providers: [{ provider: 'github', email: 'dev@kilo.ai' }],
    });
    queryClient.setQueryData(keys.organizations, [
      { organizationId: 'org-1', organizationName: 'Kilo', role: 'admin' },
    ]);

    const { renderer, unmount } = await renderWithProviders(createElement(ProfileRoute), {
      queryClient,
    });

    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');

    // The remount re-runs the interaction deferral on the fresh scene.
    interactionState.storedCallback = undefined;
    interactionState.cancel.mockClear();
    await act(async () => {
      await i18n.changeLanguage('de');
    });
    expect(interactionState.storedCallback).toBeTypeOf('function');

    // Cached rows survive the remount (the query client is shared), so the
    // fresh scene paints data immediately instead of a skeleton.
    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');

    unmount();
  });
});
