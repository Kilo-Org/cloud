import { type ReactNode } from 'react';

import { TabBarBandContext } from '@/lib/tab-bar-clearance';

/**
 * Marks a profile-management screen mounted on the root `(app)` Stack, where
 * the tabs and their bar sit underneath instead of beside the screen. The
 * shared screens keep the tab layout's bottom clearance otherwise, which would
 * leave a bar-sized band of empty space at the bottom of every root-stack
 * profile screen.
 */
export function RootStackProfileScreen({ children }: Readonly<{ children: ReactNode }>) {
  return <TabBarBandContext value={false}>{children}</TabBarBandContext>;
}
