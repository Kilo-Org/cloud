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
import { createTestQueryClient, renderWithProviders } from '@/test/render-with-providers';
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
  providersQueryFn.mockResolvedValue({ providers: [] });
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
    await act(async () => {
      await Promise.resolve();
    });

    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(1);

    unmount();
  });

  it('remounts the screen when the applied language changes', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(ProfileRoute));

    flushInteractions();
    await act(async () => {
      await Promise.resolve();
    });
    expect(nodeCountWithChildren(renderer.root, 'Text', 'Linked accounts')).toBe(1);

    // Applying a new language re-renders the route through `useTranslation`
    // and the key swap unmounts the old screen and mounts a fresh one: the
    // fresh mount re-runs the interaction deferral and re-reads the new
    // catalog. Flush the fresh scene's settled queries before asserting.
    organizationsQueryFn.mockReset();
    organizationsQueryFn.mockResolvedValue([]);
    await act(async () => {
      await i18n.changeLanguage('ar');
    });
    flushInteractions();
    await act(async () => {
      await Promise.resolve();
    });

    // Section headers read from the Arabic resource, proving the fresh mount
    // re-rendered under the applied language.
    expect(nodeCountWithChildren(renderer.root, 'Text', 'الوكلاء')).toBe(1);
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

    await act(async () => {
      await i18n.changeLanguage('de');
    });

    // Cached rows survive the remount (the query client is shared), so the
    // fresh scene paints data immediately instead of a skeleton.
    expect(findConfigureRows(renderer.root, 'GitHub')[0]?.props.subtitle).toBe('dev@kilo.ai');

    unmount();
  });
});
