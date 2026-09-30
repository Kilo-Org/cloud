import { useRouter } from 'expo-router';
import { Cpu, WandSparkles } from '@/components/ui/icons';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { openModelPicker } from '@/components/agents/model-selector';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { ConfigureRow } from '@/components/ui/configure-row';
import { PreferenceRow } from '@/components/ui/preference-row';
import { Text } from '@/components/ui/text';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useOrganization } from '@/lib/organization-context';
import { useToolSummaryTranslationPreference } from '@/lib/tool-summary-translation/tool-summary-translation-preference';

/**
 * Neutral row value while the catalogue is missing (failed or empty). The
 * state block below carries the reason and the Retry, so the row must not
 * claim a selection nor repeat the failure copy.
 */
const NO_MODEL_VALUE = '—';

/**
 * Tool-summary translation settings subpage. The switch opts every transcript
 * tool summary into gateway translation; the model row picks which gateway
 * model performs it. A translation failure silently keeps the original
 * summary, so the only non-retryable state is a stored model the live
 * catalogue dropped: the row stays enabled for the picker and a notice below
 * names that fix.
 */
export function ToolSummaryTranslationSettingsScreen() {
  const { organizationId } = useOrganization();
  const { enabled, model, hasLoaded, setEnabled, setModel } = useToolSummaryTranslationPreference();
  const { models, isLoading, isError, isFetching, isFetched, refetch } = useAvailableModels(
    organizationId ?? undefined
  );
  const { t } = useTranslation();
  const router = useRouter();

  // TanStack Query v5 resets a no-data query to `pending` when it refetches,
  // clearing `error` and setting `isLoading`, so `isError` alone would unmount
  // the error block (and its Retry) the moment the user taps it. Keeping the
  // failed state through the refetch leaves the block in place and lets the
  // Retry button show the busy state until the request settles. Same contract
  // as `use-current-user-id`.
  //
  // Only a catalogue with nothing to fall back on is an error: a failed
  // background refetch (remount after `staleTime`, or reconnect) still holds
  // the populated cache, so the stored model and the loaded catalogue keep
  // working. Blanking the row to `—` and disabling the picker there would drop
  // a working selection, which the voice-input sibling never does (it treats a
  // failed refetch as `error` only while `models` is empty).
  const catalogueError = (isError || (isLoading && isFetched)) && models.length === 0;

  // Only a live catalogue can open the picker; while off, loading, failed, or
  // empty there is nothing to pick (retry lives in the state below).
  const modelRowDisabled = !enabled || isLoading || catalogueError || models.length === 0;

  // A failed or empty catalogue keeps the neutral placeholder: the state block
  // below is the single message, so the row must not repeat the failure. While
  // a failed catalogue retries, the row stays neutral too: the busy Retry is
  // the surface's one loading indicator.
  let modelSubtitle = NO_MODEL_VALUE;
  if (isLoading && !catalogueError) {
    modelSubtitle = t('common.loading');
  } else if (!catalogueError && models.length > 0) {
    // The default Auto Small shows before any pick; a stored model the live
    // catalogue dropped falls back to its persisted name.
    modelSubtitle = models.find(candidate => candidate.id === model.id)?.name ?? model.name;
  }

  // A stored model the live catalogue dropped is kept (translations still route
  // to its id) but retry cannot restore it, so the enabled row above opens the
  // picker and this notice names that one action.
  const modelUnavailable =
    enabled &&
    !isLoading &&
    !catalogueError &&
    models.length > 0 &&
    !models.some(candidate => candidate.id === model.id);

  // The translation model carries no reasoning effort: the chosen id is the
  // whole preference. The shared picker only commits and closes on tap for a
  // single-variant row, so drop the catalogue's gateway variants here; without
  // this, choosing a variant model left the sheet open and the row on its
  // previous value, and Done was the only way to commit.
  const pickerOptions = useMemo(
    () => models.map(candidate => ({ ...candidate, variants: [] as string[] })),
    [models]
  );

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('preferences.toolSummaryTranslation')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="px-6 gap-3 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <PreferenceRow
          icon={WandSparkles}
          title={t('preferences.toolSummaryTranslation')}
          subtitle={t('preferences.toolSummaryTranslationSubtitle')}
          value={enabled}
          disabled={!hasLoaded}
          onValueChange={setEnabled}
        />
        <ConfigureRow
          icon={Cpu}
          title={t('common.model')}
          subtitle={modelSubtitle}
          className="rounded-lg bg-secondary px-3"
          last
          disabled={modelRowDisabled}
          onPress={() => {
            openModelPicker(router, {
              options: pickerOptions,
              value: model.id,
              variant: '',
              onSelect: id => {
                setModel({
                  id,
                  name: models.find(candidate => candidate.id === id)?.name ?? id,
                });
              },
            });
          }}
        />
        {modelUnavailable ? (
          // The kept model stays in the row above and the picker is the only
          // fix, so this names that one action. It must not reuse the catalogue
          // failure copy, which offers a Retry that cannot restore the model.
          <Text className="px-1 text-xs text-muted-foreground">
            {t('preferences.toolSummaryTranslationModelUnavailableNotice')}
          </Text>
        ) : null}
        {catalogueError ? (
          <QueryError
            variant="server"
            // `pt-0`: the state block sits directly below the model row, not
            // centred over the page with the `placement="top"` gap.
            className="pt-0"
            placement="top"
            title={t('common.couldNotLoadModels')}
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        ) : null}
        {!isLoading && !catalogueError && models.length === 0 ? (
          <QueryError
            // `pt-0`: same inline anchoring below the model row as the error block.
            className="pt-0"
            placement="top"
            title={t('common.noModelsAvailable')}
            onRetry={() => void refetch()}
            isRetrying={isFetching}
          />
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
