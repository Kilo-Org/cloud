import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback } from 'react';
import { BackHandler } from 'react-native';

import { PR_REVIEW_ENTRY_HREF } from '@/lib/pr-review/pr-review-entry';

/**
 * Back action shared by every PR-review detail surface: `dismissTo` pops back
 * to the inbox when the user came from there and replaces the detail screen
 * with it otherwise (a deep link, where only the tab anchor sits beneath).
 */
export function usePrReviewInboxBack(): () => void {
  const router = useRouter();

  return useCallback(() => {
    router.dismissTo(PR_REVIEW_ENTRY_HREF);
  }, [router]);
}

/**
 * The same action for Android's hardware/gesture Back. Without it the system
 * Back pops the detail route to the tab anchor — Home — because a deep link
 * renders the route on top of that anchor. Returning true consumes the event,
 * so the navigator does not also pop.
 *
 * Bound to focus, not to mount: a stack keeps lower screens mounted, and an
 * unfocused screen that kept its listener would hijack Back on whatever was
 * pushed above it. A sheet over the detail screen blurs it and registers its
 * own handler, so Back closes the sheet first.
 */
export function usePrReviewInboxHardwareBack(): void {
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        router.dismissTo(PR_REVIEW_ENTRY_HREF);
        return true;
      });
      return () => {
        subscription.remove();
      };
    }, [router])
  );
}
