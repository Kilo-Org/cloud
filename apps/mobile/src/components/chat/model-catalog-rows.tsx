import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Card } from '@/components/ui/card';
import { RowChevron } from '@/components/ui/row-chevron';
import { Cpu, Download, Star } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  type DeviceBudget,
  deviceFit,
  estimatedMemoryBytes,
  fitsDevice,
} from '@/lib/chat/device-fit';
import { type CatalogModel } from '@/lib/chat/gguf-catalog';
import { useGgufModels } from '@/lib/chat/gguf-models';
import { type HfListedModel, hfModelName } from '@/lib/chat/hf-catalog';
import { useHfSmallestDownload } from '@/lib/chat/use-hf-catalog';
import { formatFileSize } from '@/lib/format';

import { GgufDownloadControls } from './gguf-model-section';
import {
  CatalogCapabilities,
  CatalogStat,
  compactNumber,
  FitBadge,
  fitLabelKey,
  useCatalogDownload,
} from './model-catalog-parts';

const SKELETON_ROWS = 6;

/** The bytes a device downloads for the model: its file plus its projector, if it has one. */
export const downloadBytes = (model: CatalogModel) =>
  model.sizeBytes + (model.projector?.sizeBytes ?? 0);

/** One pinned catalog model: its capabilities, its size and memory, and its download. */
export function RecommendedRow({
  model,
  budget,
}: Readonly<{ model: CatalogModel; budget: DeviceBudget }>) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const snapshot = useGgufModels();
  const download = useCatalogDownload();
  const fit = deviceFit(downloadBytes(model), budget);
  const [, owner, repo] = new URL(model.url).pathname.split('/');
  const displayName = model.name.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const title = (
    <>
      <Text className="min-w-0 flex-1 font-semibold">{displayName}</Text>
      <FitBadge fit={fit} />
    </>
  );
  return (
    <Card>
      {owner !== undefined && repo !== undefined ? (
        // The title line opens the model's page, as a list row's chevron does,
        // so the card carries one button (its download) instead of a second
        // full-width "Details" button repeated in every card. The press spans
        // the card's top inset and the gap under the line, so its own node
        // reaches the 44pt target without moving the line.
        // An explicit label replaces the children's text for assistive
        // technology, so it carries the fit the badge shows as well.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[
            t('modelChat.catalog.detailsA11y', { name: displayName }),
            t(fitLabelKey(fit)),
          ].join(', ')}
          onPress={() => {
            router.push({
              pathname: '/model-catalog/[owner]/[repo]',
              params: { owner, repo },
            });
          }}
          className="-mx-4 -mb-3 -mt-4 flex-row items-center gap-3 px-4 pb-3 pt-4 active:opacity-70"
        >
          {title}
          <RowChevron />
        </Pressable>
      ) : (
        <View className="flex-row items-center gap-3">{title}</View>
      )}
      <CatalogCapabilities images={model.projector !== undefined} />
      <Text variant="muted" className="text-xs">
        {t(
          model.projector !== undefined
            ? 'modelChat.catalog.listImagePurpose'
            : 'modelChat.catalog.listTextPurpose'
        )}
      </Text>
      <Text variant="muted" className="text-xs">
        {t('modelChat.catalog.quantDetail', {
          size: formatFileSize(downloadBytes(model), i18n.language),
          memory: formatFileSize(estimatedMemoryBytes(downloadBytes(model)), i18n.language),
        })}
      </Text>
      <GgufDownloadControls
        fileId={model.fileId}
        name={model.name}
        snapshot={snapshot}
        downloadDetail={displayName}
        onDownload={
          fit === 'noStorage'
            ? undefined
            : () => {
                download(model, fit);
              }
        }
      />
    </Card>
  );
}

export function ModelRow({
  model,
  budget,
  fitsOnly,
}: Readonly<{ model: HfListedModel; budget: DeviceBudget; fitsOnly: boolean }>) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const smallest = useHfSmallestDownload(model.id, model.parameters);
  const sizeBytes = smallest.data ?? undefined;
  const fit = sizeBytes === undefined ? undefined : deviceFit(sizeBytes, budget);
  if (fitsOnly) {
    if (smallest.isPending) {
      return <ModelRowSkeleton />;
    }
    if (!fitsDevice(fit)) {
      return null;
    }
  }
  const [owner = '', repo = ''] = model.id.split('/');
  const name = hfModelName(model.id);
  const downloads = compactNumber(model.downloads, i18n.language);
  const likes = compactNumber(model.likes, i18n.language);
  const parameters =
    model.parameters === undefined ? undefined : compactNumber(model.parameters, i18n.language);
  return (
    <Pressable
      onPress={() => {
        router.push({ pathname: '/model-catalog/[owner]/[repo]', params: { owner, repo } });
      }}
      accessibilityRole="button"
      className="flex-row items-center gap-3 border-b-[0.5px] border-hair-soft px-4 py-3 active:opacity-70"
    >
      <View className="min-w-0 flex-1 gap-1">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 shrink text-sm font-medium" numberOfLines={1}>
            {name}
          </Text>
          {smallest.isFetched && <FitBadge fit={fit} />}
        </View>
        <Text variant="muted" className="text-xs" numberOfLines={1}>
          {owner}
        </Text>
        <Text variant="muted" className="text-xs">
          {t(
            model.vision
              ? 'modelChat.catalog.listImagePurpose'
              : 'modelChat.catalog.listTextPurpose'
          )}
        </Text>
        {sizeBytes !== undefined && (
          <Text variant="muted" className="text-xs">
            {t('modelChat.catalog.smallestDownload', {
              size: formatFileSize(sizeBytes, i18n.language),
              memory: formatFileSize(estimatedMemoryBytes(sizeBytes), i18n.language),
            })}
          </Text>
        )}
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          {parameters !== undefined && (
            <CatalogStat
              icon={Cpu}
              value={parameters}
              label={t('modelChat.catalog.parameters', { value: parameters })}
            />
          )}
          <CatalogStat
            icon={Download}
            value={downloads}
            label={t('modelChat.catalog.downloads', { value: downloads })}
          />
          <CatalogStat
            icon={Star}
            value={likes}
            label={t('modelChat.catalog.likes', { value: likes })}
          />
        </View>
      </View>
      <RowChevron />
    </Pressable>
  );
}

export function LoadingRows() {
  const { t } = useTranslation();
  return (
    <View accessibilityLabel={t('modelChat.catalog.loading')}>
      {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
        // eslint-disable-next-line react/no-array-index-key -- skeleton placeholders have no stable id
        <ModelRowSkeleton key={index} />
      ))}
    </View>
  );
}

/** Holds a catalog row's height while its download size, and so its fit, loads. */
function ModelRowSkeleton() {
  return (
    <View className="gap-2 border-b-[0.5px] border-hair-soft px-4 py-3">
      <Skeleton className="h-3.5 w-1/2" />
      <Skeleton className="h-3 w-1/4" />
      <Skeleton className="h-3 w-2/3" />
    </View>
  );
}
