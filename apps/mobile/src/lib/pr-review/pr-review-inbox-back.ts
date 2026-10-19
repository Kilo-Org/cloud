import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
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
 * so the navigator does not also pop. A sheet above the detail screen
 * registers its own handler last and therefore handles Back first.
 */
export function usePrReviewInboxHardwareBack(): void {
  const router = useRouter();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      router.dismissTo(PR_REVIEW_ENTRY_HREF);
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [router]);
}
