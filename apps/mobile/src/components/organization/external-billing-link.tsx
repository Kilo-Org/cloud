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
  /** What the press does, in the same words both shapes show. */
  label: string;
  className?: string;
}>;

/**
 * A control for a change that only the web can perform — buying seats,
 * changing the plan, setting up auto top-up.
 *
 * Only an iOS build in the US storefront may draw the link
 * (`useCanLinkExternalPurchase`). Every other case — another storefront, an
 * unanswered storefront, Android — prints the same label as plain text with no
 * control to press, because a review guideline forbids the link outside that
 * one storefront and Google Play forbids it everywhere. The label is shown in
 * both shapes, so the surface reads the same and only the affordance differs.
 */
export function ExternalBillingLink({ url, label, className }: ExternalBillingLinkProps) {
  const { t } = useTranslation();
  const canLink = useCanLinkExternalPurchase();
  if (!canLink) {
    return <Text className={cn('text-sm text-muted-foreground', className)}>{label}</Text>;
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
