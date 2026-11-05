import { type ReactElement } from 'react';

import { appSceneLayout } from '@/components/app-screen-layout';
import { useRepairTabStackRoot } from '@/lib/hooks/use-repair-tab-stack-root';
import { type ScreenLayoutProps } from '@/components/centered-state-surface';

/**
 * One scene of a tab's Stack: put the tab's root back beneath a screen the
 * app restored without it (`useRepairTabStackRoot`), then render the app's
 * shared scene layout.
 *
 * A scene layout renders outside the route's NavigationProvider, so the repair
 * is handed the screen's own navigation instead of reading one through a hook.
 */
export function TabStackRootRepairSceneLayout(props: ScreenLayoutProps): ReactElement {
  useRepairTabStackRoot(props.navigation);
  return appSceneLayout(props);
}