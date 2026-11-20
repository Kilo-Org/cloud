import { type Href } from 'expo-router';

import { ScreenHeader, type ScreenHeaderSlot } from '@/components/screen-header';
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
  reserveTitleSpace = false,
  subtitle,
  reserveSubtitle = false,
  subtitlePlaceholder,
  backFallback = CODE_REVIEWER_HOME_PATH,
  onBack,
}: Readonly<{
  /** The screen's own name: the product, the provider, or the list name. */
  title: string;
  /**
   * Reserve the title's line so a title that arrives with a query cannot move
   * the body below the header.
   */
  reserveTitleSpace?: boolean;
  /**
   * The one line under the title that names what the screen acts on: the
   * scope (Personal or the organization) or the review's repository. It is the
   * same two-line header the Instructions and Agents screens paint.
   */
  subtitle?: string;
  /**
   * Keep the subtitle's line in the layout while it has no text yet, so the
   * body does not move when the read that names it lands.
   */
  reserveSubtitle?: boolean;
  /** What the reserved subtitle line paints while its text loads. */
  /**
   * Element-only for the same reason `ScreenHeader`'s slots are: the header
   * paints this inside a `View`, so a string is a `Text` invariant violation,
   * not a title.
   */
  subtitlePlaceholder?: ScreenHeaderSlot;
  /** Where Back lands when the screen has no history to pop. */
  backFallback?: Href;
  /** Run this instead of navigating, e.g. while a form confirms a discard. */
  onBack?: () => void;
}>) {
  return (
    <ScreenHeader
      title={title}
      reserveTitleSpace={reserveTitleSpace}
      subtitle={subtitle}
      reserveSubtitle={reserveSubtitle}
      subtitlePlaceholder={subtitlePlaceholder}
      backFallback={backFallback}
      onBack={onBack}
    />
  );
}
