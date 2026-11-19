import { useTranslation } from 'react-i18next';

import { ConfigureRow } from '@/components/ui/configure-row';
import { MessageSquare, Smartphone, Sparkles, User } from '@/components/ui/icons';
import { RowGroup } from '@/components/ui/row-group';

/**
 * The disclosures the app cannot work without, in the order the consent card
 * lists them: what is sent, to whom, and that the account email reaches PostHog
 * so it can decide which features this person sees.
 */
export function ConsentRequiredRows() {
  const { t } = useTranslation();

  return (
    <RowGroup leadingTile>
      <ConfigureRow
        icon={MessageSquare}
        title={t('consent.promptsTitle')}
        subtitle={t('consent.promptsDescription')}
      />
      <ConfigureRow
        icon={User}
        title={t('consent.accountTitle')}
        subtitle={t('consent.accountDescription')}
      />
      <ConfigureRow
        icon={Smartphone}
        title={t('consent.diagnosticsTitle')}
        subtitle={t('consent.diagnosticsDescription')}
      />
      <ConfigureRow
        icon={Sparkles}
        title={t('consent.featureFlagsTitle')}
        subtitle={t('consent.featureFlagsDescription')}
      />
    </RowGroup>
  );
}
