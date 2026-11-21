import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';

type ExternalBillingLinkProps = Readonly<{
  /** The web page that performs the change. It does not exist in the app. */
  url: string;
  /** The control's words: what pressing it does. */
  label: string;
  className?: string;
}>;

/**
 * A control for a change that only the web can perform — buying seats,
 * changing the plan, setting up auto top-up.
 *
 * Only an iOS build in the US storefront draws this, and only the caller knows
 * that (`BillingWebSettings`). A storefront that may not link to web billing
 * gets a statement instead of this control, never the action label: the label
 * is a purchase call to action even when it is not a link.
 */
export function ExternalBillingLink({ url, label, className }: ExternalBillingLinkProps) {
  const { t } = useTranslation();
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
