'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { SettingsSection } from './CloudAgentSettingsDialog';

export type SettingsDeepLink = {
  open: boolean;
  initialSection: SettingsSection;
};

/**
 * Resolves the `settings` query into an open state and initial tab. An empty
 * value (`?settings`) is treated as the General tab.
 */
export function resolveSettingsDeepLink(settings: string | null): SettingsDeepLink {
  if (settings === '' || settings === 'general') return { open: true, initialSection: 'general' };
  if (settings === 'environments') return { open: true, initialSection: 'environments' };
  if (settings === 'profiles') return { open: true, initialSection: 'profiles' };
  if (settings === 'sidebar') return { open: true, initialSection: 'sidebar' };
  if (settings === 'compute') return { open: true, initialSection: 'compute' };
  if (settings === 'preferences') return { open: true, initialSection: 'preferences' };
  return { open: false, initialSection: 'general' };
}

/**
 * Keeps the `settings` query in sync with the settings dialog. Every entry
 * point into the dialog uses this so opening, switching tabs, and closing all
 * produce the same shareable URL.
 */
export function useCloudAgentSettingsDeepLink() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { open, initialSection } = resolveSettingsDeepLink(searchParams.get('settings'));

  const setSection = useCallback(
    (section: SettingsSection) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('settings', section);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  const clearSection = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has('settings')) return;
    params.delete('settings');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  return { open, initialSection, setSection, clearSection };
}
