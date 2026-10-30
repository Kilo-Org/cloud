import { type ComponentProps } from 'react';

import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';

/**
 * A Code Reviewer screen's failed state.
 *
 * It paints the header's back control through the fallback, which a bare
 * `PlatformErrorScreen` does not: a reviewer screen that a cold link or a
 * relaunch restore opened on its own would otherwise be a dead end whenever its
 * top-level read fails. The eyebrow stays the caller's, so a failed state reads
 * like the screen it replaces.
 */
export function ReviewerErrorScreen(
  props: Omit<ComponentProps<typeof PlatformErrorScreen>, 'backFallback'>
) {
  return <PlatformErrorScreen {...props} backFallback={CODE_REVIEWER_HOME_PATH} />;
}
