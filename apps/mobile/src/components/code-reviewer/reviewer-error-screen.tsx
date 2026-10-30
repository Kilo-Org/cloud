import { type ComponentProps } from 'react';

import { PlatformErrorScreen } from '@/components/platform-error-screen';
import { i18n } from '@/i18n';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';

/**
 * A Code Reviewer screen's failed state.
 *
 * It paints the product eyebrow and, through the fallback, the header's back
 * control, which a bare `PlatformErrorScreen` does not: a reviewer screen that
 * a cold link or a relaunch restore opened on its own would otherwise be a
 * dead end whenever its top-level read fails.
 */
export function ReviewerErrorScreen(
  props: Omit<ComponentProps<typeof PlatformErrorScreen>, 'eyebrow' | 'backFallback'>
) {
  return (
    <PlatformErrorScreen
      {...props}
      eyebrow={i18n.t('common.codeReviewer')}
      backFallback={CODE_REVIEWER_HOME_PATH}
    />
  );
}
