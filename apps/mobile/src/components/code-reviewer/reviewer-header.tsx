import { type Href } from 'expo-router';

import { ScreenHeader } from '@/components/screen-header';
import { CODE_REVIEWER_HOME_PATH } from '@/lib/profile-agent-navigation';

/**
 * The header every Code Reviewer screen paints.
 *
 * Back is part of this header, not something a screen can leave out. Both
 * entry points push these screens (the Home EXPLORE card and the Profile row),
 * so a stack usually answers Back; the fallback keeps the control painted from
 * the first frame — `router.canGoBack()` reads false while a restored screen
 * renders before its stack settles — and gives it a destination when a cold
 * link arrives with no history at all.
 */
export function ReviewerHeader({
  title,
  titleNumberOfLines,
  eyebrow,
  reserveEyebrow = false,
  backFallback = CODE_REVIEWER_HOME_PATH,
  onBack,
}: Readonly<{
  /** The screen's own title: the scope, the provider, or the list name. */
  title: string;
  /** Raise the title's line cap for prose that may wrap; the default is one. */
  titleNumberOfLines?: number;
  /**
   * The mono line above the title. This header carries every screen's own
   * shape, so each one passes what its header already showed: the list and
   * provider screens pass `t('common.codeReviewer')`, while the scope list
   * (whose title is the product name) and the edit routes keep the title-only
   * header they had.
   */
  eyebrow?: string;
  /**
   * Keep the eyebrow's line in the layout while it has no label yet. A screen
   * whose eyebrow arrives with a query reserves it so the title above the body
   * does not move when the payload lands; screens that paint an eyebrow from
   * their first frame leave it off.
   */
  reserveEyebrow?: boolean;
  /** Where Back lands when the screen has no history to pop. */
  backFallback?: Href;
  /** Run this instead of navigating, e.g. while a form confirms a discard. */
  onBack?: () => void;
}>) {
  return (
    <ScreenHeader
      title={title}
      titleNumberOfLines={titleNumberOfLines}
      eyebrow={eyebrow}
      reserveEyebrow={reserveEyebrow}
      backFallback={backFallback}
      onBack={onBack}
    />
  );
}
