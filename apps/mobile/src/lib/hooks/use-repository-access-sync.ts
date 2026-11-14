import { useNavigation } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { type ReviewerPlatform } from '@/lib/code-reviewer-config';
import {
  type SyncedRepoPlatform,
  useReviewerRepositoriesResync,
} from '@/lib/hooks/use-code-reviewer-repo-sync';
import { useManageRepositoryAccess } from '@/lib/hooks/use-manage-repository-access';

/**
 * The repository screen's refresh path: a forced provider read, plus the
 * "Manage access" launch that widens an installation.
 *
 * Access may have changed on the way to the provider's settings page, so two
 * signals report the return and only the first one syncs: the awaited browser
 * dismissal (the only one iOS reports, since its page opens in-app) and the
 * next foreground (Android).
 */
export function useRepositoryAccessSync(scope: string, platform: ReviewerPlatform) {
  const resyncPlatform: SyncedRepoPlatform = platform === 'gitlab' ? 'gitlab' : 'github';
  const { resync, resyncing } = useReviewerRepositoriesResync(scope, resyncPlatform);
  const pendingAccessChange = useRef(false);
  const navigation = useNavigation();
  const flushPendingSync = useCallback(() => {
    if (!pendingAccessChange.current) {
      return;
    }
    pendingAccessChange.current = false;
    void resync();
  }, [resync]);
  const manageAccess = useManageRepositoryAccess(scope, platform, {
    onOpen: () => {
      pendingAccessChange.current = true;
    },
    onReturn: flushPendingSync,
  });

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active' || !navigation.isFocused()) {
        return;
      }
      flushPendingSync();
    });
    return () => {
      subscription.remove();
    };
  }, [flushPendingSync, navigation]);

  return { manageAccess, resync, resyncing };
}
