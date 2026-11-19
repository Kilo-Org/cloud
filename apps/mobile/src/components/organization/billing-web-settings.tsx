import { useTranslation } from 'react-i18next';

import { ExternalBillingLink } from '@/components/organization/external-billing-link';
import { Card } from '@/components/ui/card';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { useCanLinkExternalPurchase } from '@/lib/billing/external-purchase-link';

type BillingWebSettingsProps = Readonly<{
  /** The organization's subscription page; the seats page hangs off it. */
  subscriptionsUrl: string;
  /** The plan row's words, or null when the ended-plan banner already carries it. */
  planLabel: string | null;
  /** The page that configures auto top-up. */
  autoTopUpUrl: string;
  /** The auto top-up row's words, which follow the read's state. */
  autoTopUpLabel: string;
}>;

/**
 * The billing settings that only the web can change — the plan, the seats and
 * auto top-up.
 *
 * A storefront that may link to web billing gets the three destinations as
 * controls, each under the section's heading. Every other storefront — Android,
 * and iOS outside the US — gets one statement that says where the settings
 * live: no heading naming the web, no control, and no purchase call to action,
 * because the action label is one wherever it is printed. The rule is
 * `useCanLinkExternalPurchase`.
 */
export function BillingWebSettings({
  subscriptionsUrl,
  planLabel,
  autoTopUpUrl,
  autoTopUpLabel,
}: BillingWebSettingsProps) {
  const { t } = useTranslation();
  const canLink = useCanLinkExternalPurchase();
  if (!canLink) {
    // A footnote under the card, not a card: the statement has no control and no
    // heading, so it reads as the screen's closing sentence rather than a
    // settings block the storefront withheld.
    return <Text variant="muted">{t('organization.billing.managedOnWeb')}</Text>;
  }
  return (
    <Section label={t('organization.billing.manageOnWeb')}>
      <Card>
        {planLabel === null ? null : (
          <ExternalBillingLink url={subscriptionsUrl} label={planLabel} />
        )}
        <ExternalBillingLink
          url={`${subscriptionsUrl}/seats`}
          label={t('organization.billing.buySeats')}
        />
        <ExternalBillingLink url={autoTopUpUrl} label={autoTopUpLabel} />
      </Card>
    </Section>
  );
}
