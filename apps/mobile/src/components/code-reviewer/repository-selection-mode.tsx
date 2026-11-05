import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ChoiceRow } from '@/components/ui/choice-row';
import { RadioGroup } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatNumber } from '@/lib/format';

type RepositorySelectionMode = 'all' | 'selected';

/**
 * The two modes a GitHub reviewer can store. Both rows are drawn while the
 * config read is pending, so the stored mode is the only thing that decides
 * which row reads as chosen.
 */
export function RepositoryModeChoice({
  mode,
  disabled,
  onSelect,
}: Readonly<{
  mode: RepositorySelectionMode;
  disabled: boolean;
  onSelect: (mode: RepositorySelectionMode) => void;
}>) {
  const { t } = useTranslation();
  return (
    <RadioGroup label={t('common.repositories')}>
      {(['all', 'selected'] as const).map(option => (
        <ChoiceRow
          key={option}
          label={option === 'all' ? t('common.allRepositories') : t('common.selectedRepositories')}
          selected={mode === option}
          disabled={disabled}
          className="border-b-[0.5px] border-hair-soft"
          onPress={() => {
            onSelect(option);
          }}
        />
      ))}
    </RadioGroup>
  );
}

/**
 * What "All repositories" leaves where the toggle list would be: the choice
 * covers every repository the connected GitHub app can reach, how many that is
 * right now, and the caller's own state for a list that is loading, failed or
 * empty. The count sits in a fixed-height row: it arrives after the first
 * paint, and the sync footer below it must not move when it does.
 */
export function AllRepositoriesSummary({
  personal,
  loading,
  count,
  children,
}: Readonly<{
  /** The repository choice follows the reader's own GitHub connection. */
  personal: boolean;
  loading: boolean;
  /** `null` while the snapshot is unknown, failed or empty. */
  count: number | null;
  children?: ReactNode;
}>) {
  const { t } = useTranslation();
  return (
    <View className="mt-6 gap-2">
      <Text variant="muted" className="text-xs">
        {t(
          personal ? 'codeReviewer.repos.allModePersonal' : 'codeReviewer.repos.allModeOrganization'
        )}
      </Text>
      <View className="h-5 justify-center">
        {loading && <Skeleton className="h-4 w-40 rounded" />}
        {count !== null && (
          <Text variant="muted" className="text-xs">
            {t('codeReviewer.repos.allModeCount', {
              displayCount: formatNumber(count, i18n.language),
            })}
          </Text>
        )}
      </View>
      {children}
    </View>
  );
}
