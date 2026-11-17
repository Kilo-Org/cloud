import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useCanLinkExternalPurchase } from '@/lib/billing/external-purchase-link';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';

type ExternalBillingLinkProps = Readonly<{
  /** The web page that performs the change. It does not exist in the app. */
  url: string;
  /** The control's words: what pressing it does. */
  label: string;
  /**
   * The same destination stated as a fact, for the surface that may not draw
   * the control. It never instructs a purchase and never points anywhere: the
   * plain text is a status line, not an action.
   */
  description: string;
  className?: string;
}>;

/**
 * A control for a change that only the web can perform — buying seats,
 * changing the plan, setting up auto top-up.
 *
 * Only an iOS build in the US storefront may draw the link
 * (`useCanLinkExternalPurchase`). Every other case — another storefront, an
 * unanswered storefront, Android — draws no control and no call to action,
 * because a review guideline forbids the link outside that one storefront and
 * Google Play forbids it everywhere. Those surfaces show `description` instead:
 * the action label is a purchase call to action wherever it is printed, even
 * without a link to press.
 */
export function ExternalBillingLink({
  url,
  label,
  description,
  className,
}: ExternalBillingLinkProps) {
  const { t } = useTranslation();
  const canLink = useCanLinkExternalPurchase();
  if (!canLink) {
    return <Text className={cn('text-sm text-muted-foreground', className)}>{description}</Text>;
  }
  return (
    <Button
      variant="outline"
      className={cn(STATE_ACTION_CLASS, className)}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('organization.billing.opensOnWeb')}
      onPress={() => {
        void openExternalUrl(url, { label });
      }}
    >
      <Text>{label}</Text>
    </Button>
  );
}
