import { type RepositoryModelOverrideInput } from '@kilocode/app-shared/code-review';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { openModelPicker } from '@/components/agents/model-selector';
import { Text } from '@/components/ui/text';
import {
  LINE_ACTION_BOX_CLASS,
  LINE_ACTION_HIT_SLOP,
  ROW_TARGET_CLASS,
} from '@/lib/a11y/tap-target';
import { modelLabelFromCatalogue } from '@/lib/auto-model-name';
import { type ModelOption, thinkingEffortLabel } from '@/lib/hooks/use-available-models';
import { cn } from '@/lib/utils';

/** One repository the section can override: its platform id and its display name. */
export type OverridableRepository = Readonly<{
  id: number | string;
  fullName: string;
}>;

/**
 * Per-repository model + thinking effort (the web form's "Per-repository
 * model" block). Every selected repository gets a row; a row without an
 * override follows the reviewer's default model, and picking a model writes an
 * override while Reset removes it.
 *
 * The model choice and Reset are sibling touch targets rather than one nested
 * inside the other: a pressable inside a pressable is the shape Android
 * dispatches to whichever node claims the touch first, and the screen reader
 * then meets two controls for one row.
 */
export function RepositoryModelOverrides({
  repositories,
  overrides,
  defaultModelSlug,
  models,
  modelsLoading,
  disabled,
  onSet,
  onRemove,
}: Readonly<{
  repositories: readonly OverridableRepository[];
  overrides: readonly RepositoryModelOverrideInput[];
  defaultModelSlug: string;
  models: ModelOption[];
  modelsLoading: boolean;
  disabled: boolean;
  onSet: (override: RepositoryModelOverrideInput) => void;
  onRemove: (repositoryId: number | string) => void;
}>) {
  const { t } = useTranslation();
  const router = useRouter();

  if (repositories.length === 0) {
    return null;
  }

  const modelLine = (override: RepositoryModelOverrideInput | undefined) => {
    if (!override) {
      return t('codeReviewer.repoModels.defaultModel');
    }
    const label = modelLabelFromCatalogue(models, override.modelSlug);
    return override.thinkingEffort
      ? `${label} · ${thinkingEffortLabel(override.thinkingEffort)}`
      : label;
  };

  const openPicker = (
    repo: OverridableRepository,
    override: RepositoryModelOverrideInput | undefined
  ) => {
    openModelPicker(router, {
      options: models,
      value: override?.modelSlug ?? defaultModelSlug,
      variant: override?.thinkingEffort ?? '',
      acceptsVariant: true,
      onSelect: (modelSlug, variant) => {
        onSet({
          repositoryId: repo.id,
          repoFullName: repo.fullName,
          modelSlug,
          thinkingEffort: variant || null,
        });
      },
    });
  };

  return (
    <View className="mt-6">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('codeReviewer.repoModels.title')}
      </Text>
      <Text variant="muted" className="mt-1 mb-2 text-xs">
        {t('codeReviewer.repoModels.description')}
      </Text>
      <View>
        {repositories.map((repo, index) => {
          const override = overrides.find(entry => entry.repositoryId === repo.id);
          const last = index === repositories.length - 1;
          return (
            <View
              key={String(repo.id)}
              className={cn(
                'flex-row items-center gap-3 py-1',
                !last && 'border-b-[0.5px] border-hair-soft'
              )}
            >
              <Pressable
                className={cn(
                  ROW_TARGET_CLASS,
                  'min-w-0 flex-1 justify-center active:opacity-70',
                  (disabled || modelsLoading) && 'opacity-60'
                )}
                disabled={disabled || modelsLoading}
                accessibilityRole="button"
                accessibilityLabel={repo.fullName}
                accessibilityHint={t('codeReviewer.repoModels.changeHint')}
                accessibilityState={{ disabled: disabled || modelsLoading }}
                onPress={() => {
                  openPicker(repo, override);
                }}
              >
                <Text className="text-sm font-medium" numberOfLines={1}>
                  {repo.fullName}
                </Text>
                <Text variant="muted" className="mt-0.5 text-xs" numberOfLines={1}>
                  {modelLine(override)}
                </Text>
              </Pressable>
              {override ? (
                <Pressable
                  className={cn(LINE_ACTION_BOX_CLASS, 'justify-center px-2 active:opacity-70')}
                  hitSlop={LINE_ACTION_HIT_SLOP}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={t('codeReviewer.repoModels.resetLabel', {
                    repository: repo.fullName,
                  })}
                  accessibilityState={{ disabled }}
                  onPress={() => {
                    onRemove(repo.id);
                  }}
                >
                  <Text variant="muted" className="text-xs underline">
                    {t('securityAgent.filter.reset')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}
