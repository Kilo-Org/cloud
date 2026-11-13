import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { ArrowUp, CheckCircle2, Download, RotateCcw, Share2, X } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import { formatFileSize } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { transferErrorMessage } from '@/lib/ssh/files/error-copy';
import { type SshTransfer } from '@/lib/ssh/files/transfers';

type TransfersTrayProps = Readonly<{
  transfers: readonly SshTransfer[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onShare: (transfer: SshTransfer) => void;
  onClear: () => void;
}>;

/**
 * The transfers the browser is running, newest first. It sits under the list so
 * a transfer stays visible while the person keeps browsing.
 */
export function TransfersTray({
  transfers,
  onCancel,
  onRetry,
  onShare,
  onClear,
}: TransfersTrayProps) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  if (transfers.length === 0) {
    return null;
  }
  const finished = transfers.some(transfer => transfer.status !== 'active');

  return (
    <View className="border-t border-hair-soft bg-background px-4 pt-2 pb-1">
      <View className="flex-row items-center justify-between gap-2">
        <Text
          accessibilityRole="header"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          {t('ssh.files.transfers.title')}
        </Text>
        {finished ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('ssh.files.transfers.clear')}
            hitSlop={8}
            onPress={onClear}
          >
            <Text className="text-xs font-medium text-muted-foreground">
              {t('ssh.files.transfers.clear')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {transfers.map(transfer => (
        <View key={transfer.id} className="flex-row items-center gap-2 py-1.5">
          <View className="w-4 items-center">
            {transfer.kind === 'upload' ? (
              <ArrowUp size={16} color={colors.mutedForeground} />
            ) : (
              <Download size={16} color={colors.mutedForeground} />
            )}
          </View>
          <View className="min-w-0 flex-1 gap-0.5">
            <Text className="text-sm text-foreground" numberOfLines={1}>
              {transfer.name}
            </Text>
            <Text
              className={
                transfer.status === 'failed'
                  ? 'text-xs text-destructive'
                  : 'text-xs text-muted-foreground'
              }
              numberOfLines={2}
            >
              {transferStatusLabel(transfer, t, i18n.language)}
            </Text>
            {transfer.status === 'active' ? <TransferBar transfer={transfer} /> : null}
          </View>
          <TransferAction
            transfer={transfer}
            onCancel={onCancel}
            onRetry={onRetry}
            onShare={onShare}
          />
        </View>
      ))}
    </View>
  );
}

function TransferAction({
  transfer,
  onCancel,
  onRetry,
  onShare,
}: Readonly<{
  transfer: SshTransfer;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onShare: (transfer: SshTransfer) => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  if (transfer.status === 'active') {
    return (
      <IconButton
        accessibilityLabel={t('ssh.files.transfers.cancel', { name: transfer.name })}
        onPress={() => {
          onCancel(transfer.id);
        }}
      >
        <X size={16} color={colors.mutedForeground} />
      </IconButton>
    );
  }
  if (transfer.status === 'failed' || transfer.status === 'cancelled') {
    return (
      <IconButton
        accessibilityLabel={t('ssh.files.transfers.retry', { name: transfer.name })}
        onPress={() => {
          onRetry(transfer.id);
        }}
      >
        <RotateCcw size={16} color={colors.mutedForeground} />
      </IconButton>
    );
  }
  if (transfer.kind === 'download') {
    return (
      <IconButton
        accessibilityLabel={t('ssh.files.transfers.share', { name: transfer.name })}
        onPress={() => {
          onShare(transfer);
        }}
      >
        <Share2 size={16} color={colors.mutedForeground} />
      </IconButton>
    );
  }
  return <CheckCircle2 size={16} color={colors.mutedForeground} />;
}

function transferStatusLabel(transfer: SshTransfer, t: TFunction, language: string): string {
  if (transfer.status === 'failed') {
    return transferErrorMessage(t, transfer.code);
  }
  if (transfer.status === 'cancelled') {
    return t('ssh.files.transfers.cancelled');
  }
  if (transfer.status === 'done') {
    return t('ssh.files.transfers.done', { size: formatFileSize(transfer.bytes, language) });
  }
  if (transfer.total === null || transfer.total === 0) {
    return t('ssh.files.transfers.activeUnknown', {
      size: formatFileSize(transfer.bytes, language),
    });
  }
  const percent = Math.floor((transfer.bytes / transfer.total) * 100);
  return t('ssh.files.transfers.active', {
    percent,
    transferred: formatFileSize(transfer.bytes, language),
    total: formatFileSize(transfer.total, language),
  });
}

function TransferBar({ transfer }: Readonly<{ transfer: SshTransfer }>) {
  const total = transfer.total;
  const percent =
    total === null || total === 0 ? null : Math.min(100, Math.floor((transfer.bytes / total) * 100));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={percent === null ? undefined : { min: 0, max: 100, now: percent }}
      className="mt-0.5 h-1 overflow-hidden rounded-full bg-secondary"
    >
      <View
        className="h-full rounded-full bg-primary"
        style={{ width: percent === null ? '30%' : `${percent}%` }}
      />
    </View>
  );
}
