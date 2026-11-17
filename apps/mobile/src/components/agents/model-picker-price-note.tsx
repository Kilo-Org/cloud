import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { modelPickerCostLabel } from '@/lib/model-cost';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

/**
 * The footnote under the model picker list for the per-1M prices its rows show.
 * It reads the whole catalog, not the filtered rows, so typing a query never
 * adds or drops it.
 */
export function ModelPickerPriceNote({
  options,
}: Readonly<{ options: readonly SessionModelOption[] }>) {
  const { t } = useTranslation();
  if (!options.some(option => modelPickerCostLabel(option) !== null)) {
    return null;
  }
  return (
    <Text className="px-4 py-3 text-xs text-muted-foreground">
      {t('agentChat.modelCost.preferredProviderNote')}
    </Text>
  );
}
