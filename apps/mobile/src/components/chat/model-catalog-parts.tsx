import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';

import { Eye, FileText, type LucideIcon } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { type DeviceFit } from '@/lib/chat/device-fit';
import { type CatalogModel } from '@/lib/chat/gguf-catalog';
import { ggufDownloadActions } from '@/lib/chat/gguf-models';
import { formatNumber } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const FIT_STYLES = {
  fits: { key: 'modelChat.catalog.fit.fits', tile: 'bg-good-tile-bg', text: 'text-good' },
  tight: { key: 'modelChat.catalog.fit.tight', tile: 'bg-warn-tile-bg', text: 'text-warn' },
  tooLarge: {
    key: 'modelChat.catalog.fit.tooLarge',
    tile: 'bg-danger-tile-bg',
    text: 'text-destructive',
  },
  noStorage: {
    key: 'modelChat.catalog.fit.noStorage',
    tile: 'bg-danger-tile-bg',
    text: 'text-destructive',
  },
} as const satisfies Record<DeviceFit, { key: string; tile: string; text: string }>;

/** Says how the file fits this device, or that the device cannot judge the fit. */
export function FitBadge({ fit }: Readonly<{ fit: DeviceFit | undefined }>) {
  const { t } = useTranslation();
  if (fit === undefined) {
    return (
      <View className="shrink-0 rounded-full bg-secondary px-2 py-0.5">
        <Text className="text-xs text-muted-foreground">{t('modelChat.catalog.fit.unknown')}</Text>
      </View>
    );
  }
  const style = FIT_STYLES[fit];
  return (
    <View className={cn('shrink-0 rounded-full px-2 py-0.5', style.tile)}>
      <Text className={cn('text-xs font-medium', style.text)}>{t(style.key)}</Text>
    </View>
  );
}

export function CatalogCapabilities({ images }: Readonly<{ images: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row flex-wrap gap-x-3 gap-y-1">
      <CatalogStat
        icon={FileText}
        value={t('modelChat.catalog.text')}
        label={t('modelChat.catalog.text')}
      />
      {images && (
        <CatalogStat
          icon={Eye}
          value={t('modelChat.catalog.vision')}
          label={t('modelChat.catalog.vision')}
        />
      )}
    </View>
  );
}

export function compactNumber(value: number, locale: string): string {
  return formatNumber(value, locale, { notation: 'compact', maximumFractionDigits: 1 });
}

/** An icon and a short value; the label carries the words a screen reader needs. */
export function CatalogStat({
  icon: Icon,
  value,
  label,
}: Readonly<{ icon: LucideIcon; value: string; label: string }>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center gap-1" accessible accessibilityLabel={label}>
      <Icon size={13} color={colors.mutedForeground} />
      <Text variant="muted" className="text-xs">
        {value}
      </Text>
    </View>
  );
}

/** Starts a download; a model too large for this device's memory asks first. */
export function useCatalogDownload() {
  const { t } = useTranslation();
  return (model: CatalogModel, fit: DeviceFit | undefined) => {
    const start = () => {
      ggufDownloadActions.start({ kind: 'catalog', model });
    };
    if (fit !== 'tooLarge') {
      start();
      return;
    }
    Alert.alert(
      t('modelChat.catalog.tooLargeTitle'),
      t('modelChat.catalog.tooLargeMessage', { name: model.name }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('modelChat.catalog.downloadAnyway'), onPress: start },
      ]
    );
  };
}
