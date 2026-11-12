import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { externalBillingAction } from '@/lib/external-billing-action';
import { openExternalUrl } from '@/lib/external-link';
import { cn } from '@/lib/utils';

type ExternalBillingLinkProps = Readonly<{
  /** The web page that performs the change. It does not exist in the app. */
  url: string;
  /** What the press does, in the same words both platforms show. */
  label: string;
  className?: string;
}>;

/**
 * A control for a change that only the web can perform — buying seats,
 * changing the plan, setting up auto top-up.
 *
 * The platform decides the shape (`externalBillingAction`): Android opens the
 * page in the browser, and iOS prints the destination as selectable text under
 * the same label, because an in-app link to an external purchase page is not
 * allowed there. The label is shown on both, so the control reads the same on
 * either platform and only the affordance differs.
 */
export function ExternalBillingLink({ url, label, className }: ExternalBillingLinkProps) {
  const { t } = useTranslation();
  const action = externalBillingAction(url);
  if (action.kind === 'text') {
    return (
      <View className={cn('gap-1', className)}>
        <Text className="text-sm text-muted-foreground">{label}</Text>
        <Text
          className="text-sm text-foreground"
          selectable
          accessibilityLabel={t('organization.billing.webAddress', { url })}
        >
          {action.url}
        </Text>
      </View>
    );
  }
  return (
    <Button
      variant="outline"
      className={cn(STATE_ACTION_CLASS, className)}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${t('organization.billing.opensOnWeb')}`}
      onPress={() => {
        void openExternalUrl(url, { label });
      }}
    >
      <Text>{label}</Text>
    </Button>
  );
}
