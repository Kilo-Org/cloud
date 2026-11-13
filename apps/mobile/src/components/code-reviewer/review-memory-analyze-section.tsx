import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { ChevronDown } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS, STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

export type AnalyzableRepository = Readonly<{
  repoFullName: string;
}>;

/**
 * "Analyze now" for review memory: pick one of the repositories that recently
 * received maintainer replies, then ask the model to look for a single repeated
 * guidance pattern (the web panel's Analyze feedback card).
 *
 * The picker's rows are the summary's own repository list, so the section can
 * never offer a repository the server would answer `no_feedback` for. When that
 * list is empty there is nothing to run, and the card says so instead of
 * disabling an unexplained button.
 */
export function ReviewMemoryAnalyzeSection({
  repositories,
  onAnalyze,
  pending,
  disabled,
}: Readonly<{
  repositories: readonly AnalyzableRepository[];
  onAnalyze: (repoFullName: string) => void;
  pending: boolean;
  /** Read-only viewers (org members without a billing role) see the card but cannot run it. */
  disabled: boolean;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);

  // A repository that disappears from the summary (its replies aged out) must
  // not stay chosen: the button would then send an analysis the server can
  // only answer `no_feedback` for, after the row it named is gone.
  const names = new Set(repositories.map(repo => repo.repoFullName));
  const selected = chosen !== null && names.has(chosen) ? chosen : null;
  const canAnalyze = !disabled && !pending && selected !== null;

  if (repositories.length === 0) {
    return (
      <View className="gap-2 rounded-lg bg-secondary p-4">
        <Text className="text-sm font-medium">{t('codeReviewer.reviewMemory.analyze.title')}</Text>
        <Text variant="muted" className="text-xs">
          {t('codeReviewer.reviewMemory.analyze.noRepositories')}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3 rounded-lg bg-secondary p-4">
      <View className="gap-1">
        <Text className="text-sm font-medium">{t('codeReviewer.reviewMemory.analyze.title')}</Text>
        <Text variant="muted" className="text-xs">
          {t('codeReviewer.reviewMemory.analyze.description')}
        </Text>
      </View>
      <Pressable
        className={cn(ROW_TARGET_CLASS, 'justify-center active:opacity-70')}
        disabled={disabled || pending}
        accessibilityRole="button"
        accessibilityLabel={t('common.repository')}
        accessibilityValue={{
          text: selected ?? t('codeReviewer.reviewMemory.analyze.chooseRepository'),
        }}
        accessibilityState={{ disabled: disabled || pending }}
        onPress={() => {
          setPickerOpen(true);
        }}
      >
        <View className="flex-row items-center justify-between gap-3 rounded-lg border border-hair-soft px-3 py-2">
          <Text
            className={cn('flex-1 text-sm', selected === null && 'text-muted-foreground')}
            numberOfLines={1}
          >
            {selected ?? t('codeReviewer.reviewMemory.analyze.chooseRepository')}
          </Text>
          <ChevronDown size={16} color={colors.mutedForeground} />
        </View>
      </Pressable>
      <Button
        className={STATE_ACTION_CLASS}
        loading={pending}
        disabled={!canAnalyze}
        accessibilityLabel={t('codeReviewer.reviewMemory.analyze.action')}
        onPress={() => {
          if (selected !== null) {
            onAnalyze(selected);
          }
        }}
      >
        <Text>{t('codeReviewer.reviewMemory.analyze.action')}</Text>
      </Button>

      <Sheet
        visible={pickerOpen}
        onClose={() => {
          setPickerOpen(false);
        }}
        snapPoints={['60%']}
      >
        <View className="flex-1">
          <Text className="px-6 pt-4 pb-3 text-base font-semibold">{t('common.repository')}</Text>
          <ScrollView className="flex-1" contentContainerClassName="px-6 pb-6">
            {repositories.map(repo => (
              <ChoiceRow
                key={repo.repoFullName}
                label={repo.repoFullName}
                selected={selected === repo.repoFullName}
                onPress={() => {
                  setChosen(repo.repoFullName);
                  setPickerOpen(false);
                }}
              />
            ))}
          </ScrollView>
        </View>
      </Sheet>
    </View>
  );
}
