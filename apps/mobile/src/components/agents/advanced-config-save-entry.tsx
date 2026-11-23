import { useTranslation } from 'react-i18next';

import { OrganizationPlanRefusal } from '@/components/organization/plan-refusal';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type AdvancedConfigSaveEntryProps = Readonly<{
  disabled: boolean;
  /**
   * The organization plan gate's refusal for the selected account, already
   * translated, or null when the account may save.
   */
  planRefusal: string | null;
  onSave: () => void;
}>;

/**
 * The advanced configuration's save entry, split from the panel that the repo's
 * line cap no longer fits: `Save as profile`, or the plan refusal standing where
 * it would be. Every organization profile write is refused while that gate
 * refuses, so the entry becomes the state instead of opening a sheet whose save
 * fails.
 */
export function AdvancedConfigSaveEntry({
  disabled,
  planRefusal,
  onSave,
}: Readonly<AdvancedConfigSaveEntryProps>) {
  const { t } = useTranslation();
  if (planRefusal !== null) {
    return <OrganizationPlanRefusal message={planRefusal} />;
  }
  return (
    <Button
      onPress={onSave}
      disabled={disabled}
      accessibilityLabel={t('agentChat.newSession.saveAsProfile')}
    >
      <Text>{t('agentChat.newSession.saveAsProfile')}</Text>
    </Button>
  );
}
