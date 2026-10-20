import { FlashList } from '@shopify/flash-list';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { EmptyState } from '@/components/empty-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Eyebrow } from '@/components/ui/eyebrow';
import {
  Cpu,
  Download,
  FileSearch,
  Lock,
  type LucideIcon,
  Scale,
  Star,
  Wrench,
} from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { type DeviceBudget, deviceFit, estimatedMemoryBytes } from '@/lib/chat/device-fit';
import { useGgufModels } from '@/lib/chat/gguf-models';
import { type HfModelDetail, hfModelName, type HfQuant, isHfRepoId } from '@/lib/chat/hf-catalog';
import { useModelCatalogBack, useModelCatalogHardwareBack } from '@/lib/chat/model-catalog-back';
import { HfRequestError, useDeviceBudget, useHfModelDetail } from '@/lib/chat/use-hf-catalog';
import { formatFileSize } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { GgufDownloadControls } from './gguf-model-section';
import {
  CatalogCapabilities,
  CatalogStat,
  compactNumber,
  FitBadge,
  useCatalogDownload,
} from './model-catalog-parts';

function Hint({ icon: Icon, label }: Readonly<{ icon: LucideIcon; label: string }>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-1.5 rounded-full bg-secondary px-2.5 py-1">
      <Icon size={13} color={colors.foreground} />
      <Text className="text-xs">{label}</Text>
    </View>
  );
}

function Summary({ detail }: Readonly<{ detail: HfModelDetail }>) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const downloads = compactNumber(detail.downloads, i18n.language);
  const likes = compactNumber(detail.likes, i18n.language);
  const parameters =
    detail.parameters === undefined ? undefined : compactNumber(detail.parameters, i18n.language);
  const context =
    detail.contextLength === undefined
      ? undefined
      : compactNumber(detail.contextLength, i18n.language);
  return (
    <View className="gap-4 px-6 pb-2 pt-2">
      <View className="flex-row flex-wrap gap-x-4 gap-y-2">
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
        {context !== undefined && (
          <Text variant="muted" className="text-xs">
            {t('modelChat.catalog.context', { value: context })}
          </Text>
        )}
      </View>
      <View className="flex-row items-center gap-2">
        <Scale size={14} color={colors.mutedForeground} />
        <Text variant="muted" className="min-w-0 shrink">
          {detail.license === undefined
            ? t('modelChat.catalog.licenseUnknown')
            : t('modelChat.catalog.license', { license: detail.license })}
        </Text>
      </View>
      <View className="gap-2">
        <View className="flex-row flex-wrap items-center gap-2">
          <CatalogCapabilities images={detail.vision} />
          {detail.tools && <Hint icon={Wrench} label={t('modelChat.catalog.tools')} />}
        </View>
        {(detail.tools || detail.vision) && (
          <Text variant="muted" className="text-xs">
            {t('modelChat.catalog.hintsHelp')}
          </Text>
        )}
      </View>
      {detail.gated && (
        <View className="flex-row items-start gap-2 rounded-xl bg-warn-tile-bg p-3">
          <Lock size={16} color={colors.warn} />
          <Text className="min-w-0 shrink text-sm text-warn">{t('modelChat.catalog.gated')}</Text>
        </View>
      )}
      <View className="gap-1 pt-2">
        <Eyebrow>{t('modelChat.catalog.quantizations')}</Eyebrow>
        <Text variant="muted" className="text-xs">
          {t('modelChat.catalog.quantizationsHelp')}
        </Text>
        <Text variant="muted" className="text-xs">
          {t('modelChat.catalog.memoryEstimateNote')}
        </Text>
      </View>
    </View>
  );
}

function QuantRow({
  quant,
  gated,
  budget,
}: Readonly<{ quant: HfQuant; gated: boolean; budget: DeviceBudget }>) {
  const { t, i18n } = useTranslation();
  const snapshot = useGgufModels();
  const download = useCatalogDownload();
  const bytes = quant.model.sizeBytes + (quant.model.projector?.sizeBytes ?? 0);
  const fit = deviceFit(bytes, budget);
  const blocked = gated || fit === 'noStorage';
  return (
    <View className="mx-6 mb-3 gap-2 rounded-xl border border-border bg-card p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="min-w-0 shrink font-mono-medium text-sm" numberOfLines={1}>
          {quant.label}
        </Text>
        <FitBadge fit={fit} />
      </View>
      <Text variant="muted">
        {t('modelChat.catalog.quantDetail', {
          size: formatFileSize(bytes, i18n.language),
          memory: formatFileSize(estimatedMemoryBytes(bytes), i18n.language),
        })}
      </Text>
      <Text variant="muted" className="text-xs">
        {t('modelChat.catalog.fullFileName', { name: quant.path.split('/').pop() ?? quant.path })}
      </Text>
      {quant.model.license !== '' && (
        <Text variant="muted" className="text-xs">
          {t('modelChat.catalog.license', { license: quant.model.license })}
        </Text>
      )}
      <GgufDownloadControls
        fileId={quant.model.fileId}
        name={quant.model.name}
        snapshot={snapshot}
        onDownload={
          blocked
            ? undefined
            : () => {
                download(quant.model, fit);
              }
        }
        downloadLabel={t('modelChat.catalog.downloadQuant', { quant: quant.label })}
      />
    </View>
  );
}

function LoadingDetail() {
  const { t } = useTranslation();
  return (
    <View accessibilityLabel={t('modelChat.catalog.loadingModel')} className="gap-3 px-6 pt-2">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-4 h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
    </View>
  );
}

function DetailBody({ id }: Readonly<{ id: string }>) {
  const { t } = useTranslation();
  const query = useHfModelDetail(id);
  const budget = useDeviceBudget();
  if (query.isPending) {
    return <LoadingDetail />;
  }
  if (query.isError) {
    return query.error instanceof HfRequestError && query.error.status === 404 ? (
      <QueryError variant="not-found" />
    ) : (
      <QueryError
        variant="server"
        title={t('modelChat.catalog.couldNotLoadModel')}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }
  const detail = query.data;
  return (
    <FlashList
      data={detail.quants}
      keyExtractor={quant => quant.path}
      renderItem={({ item }) => <QuantRow quant={item} gated={detail.gated} budget={budget} />}
      ListHeaderComponent={<Summary detail={detail} />}
      ListEmptyComponent={
        <EmptyState
          icon={FileSearch}
          title={t('modelChat.catalog.noFiles')}
          description={t('modelChat.catalog.noFilesDescription')}
          placement="top"
        />
      }
      ListFooterComponent={<View className="h-12" />}
    />
  );
}

/** One Hugging Face repository: what it is, and every file this device can download. */
export function ModelCatalogDetailScreen({ id }: Readonly<{ id: string }>) {
  const valid = isHfRepoId(id);
  // Both exits land on the catalog list, also when this route was opened
  // without the list beneath it (a deep link); see `model-catalog-back`.
  const backToCatalog = useModelCatalogBack();
  useModelCatalogHardwareBack();
  return (
    <View className="flex-1 bg-background">
      <ScreenHeader
        title={valid ? hfModelName(id) : undefined}
        eyebrow={valid ? id.split('/')[0] : undefined}
        showBackButton
        onBack={backToCatalog}
      />
      {valid ? <DetailBody id={id} /> : <QueryError variant="not-found" />}
    </View>
  );
}
