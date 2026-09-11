import { type ReactNode } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EmptyState } from '@/components/empty-state';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { ChoiceRow } from '@/components/ui/choice-row';
import { Mic } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { useTranscriptionModels } from '@/lib/hooks/use-transcription-models';
import { useOrganization } from '@/lib/organization-context';
import {
  useGatewayTranscriptionModel,
  useGatewayTranscriptionModelLoaded,
  writeGatewayTranscriptionModel,
} from '@/lib/voice-input/gateway/gateway-transcription-preference';

// Static skeleton rows: count and shape match the real ChoiceRow rows
// (name line + id caption; the final row's trailing check is transparent
// unless selected, so the skeleton carries no trailing control) so the swap
// never moves layout and never shows a shape the loaded row will not have.
const SKELETON_ROW_COUNT = 6;

function SkeletonRows() {
  return (
    <View className="px-4 pb-4 pt-1">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        // eslint-disable-next-line react/no-array-index-key -- static skeleton rows, no reordering
        <View key={index} className="min-h-11 flex-row items-center justify-between py-3">
          <View className="flex-1 gap-1.5 pr-3">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-28" />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Picks the gateway transcription model for voice input. Writes the
 * SecureStore-backed store directly — no picker bridge — and dismisses on
 * selection, mirroring the language picker's route shell.
 */
export function TranscriptionModelPickerSheet() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { organizationId } = useOrganization();
  // Scope the catalogue to the selected organization so the picker cannot
  // offer, or check-mark, a model the scoped upload then rejects.
  const { models, isLoading, isError, refetch } = useTranscriptionModels(
    organizationId ?? undefined
  );
  const storedModel = useGatewayTranscriptionModel();
  // With no explicit choice the gateway's first catalogue model is the
  // default, so the check mark lands on the row the engine will run.
  const selectedModelId = storedModel?.id ?? models[0]?.id;
  // The SecureStore read resolves after mount; until it does the stored-model
  // comparison would report "no choice" and draw every row unchecked. Hold
  // the skeleton state until both sources settle so the rows render once,
  // with the correct check on the current model.
  const modelStoreLoaded = useGatewayTranscriptionModelLoaded();

  let content: ReactNode = null;
  if (isLoading || !modelStoreLoaded) {
    content = <SkeletonRows />;
  } else if (isError && models.length === 0) {
    // A failed refresh keeps the loaded rows on screen: the error state
    // only takes over when there is nothing to keep.
    content = (
      <QueryError title={t('transcriptionModel.loadFailed')} onRetry={() => void refetch()} />
    );
  } else if (models.length === 0) {
    content = (
      <EmptyState
        icon={Mic}
        title={t('transcriptionModel.emptyTitle')}
        description={t('transcriptionModel.emptyDescription')}
      />
    );
  } else {
    content = (
      <FlatList
        className="flex-1 bg-background"
        data={models}
        keyExtractor={item => item.id}
        contentContainerClassName="px-4 pb-4"
        ListFooterComponent={<View style={{ height: insets.bottom }} pointerEvents="none" />}
        renderItem={({ item, index }) => (
          <ChoiceRow
            label={item.name}
            description={item.id}
            className={index < models.length - 1 ? 'border-b-[0.5px] border-hair-soft' : undefined}
            selected={selectedModelId === item.id}
            onPress={() => {
              writeGatewayTranscriptionModel({ id: item.id, name: item.name });
              router.back();
            }}
          />
        )}
      />
    );
  }

  return (
    <PickerSheet
      title={t('transcriptionModel.title')}
      doneLabel={t('common.done')}
      onDone={() => {
        router.back();
      }}
      onCancel={() => {
        router.back();
      }}
      scrollable={false}
    >
      {content}
    </PickerSheet>
  );
}
