import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';

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
  backFallback = CODE_REVIEWER_HOME_PATH,
  onBack,
}: Readonly<{
  /** The screen's own title: the scope, the provider, or the list name. */
  title: string;
  /** Raise the title's line cap for prose that may wrap; the default is one. */
  titleNumberOfLines?: number;
  /** Override the mono line above the title, which names the product. */
  eyebrow?: string;
  /** Where Back lands when the screen has no history to pop. */
  backFallback?: Href;
  /** Run this instead of navigating, e.g. while a form confirms a discard. */
  onBack?: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <ScreenHeader
      title={title}
      titleNumberOfLines={titleNumberOfLines}
      eyebrow={eyebrow ?? t('common.codeReviewer')}
      backFallback={backFallback}
      onBack={onBack}
    />
  );
}
