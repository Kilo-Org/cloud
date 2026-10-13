import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { PackageSearch } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { GGUF_URL_ERROR_KEYS, readGgufLink } from '@/lib/chat/gguf-catalog';
import { ggufDownloadActions, ggufUrlSource, useGgufModels } from '@/lib/chat/gguf-models';
import {
  type GgufDownload,
  type GgufDownloadProblem,
  type GgufDownloadsSnapshot,
} from '@/lib/chat/gguf-records';
import { formatFileSize } from '@/lib/format';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

import { modelCapabilityKey } from './model-tools-hint';

const FAILURE_KEYS = {
  space: 'modelChat.gguf.errors.space',
  network: 'modelChat.gguf.errors.network',
  invalidFile: 'modelChat.gguf.errors.invalidFile',
  checksum: 'modelChat.gguf.errors.checksum',
} as const satisfies Record<GgufDownloadProblem, string>;

function progressKey(download: GgufDownload): string {
  if (download.phase === 'verifying') {
    return 'modelChat.gguf.verifying';
  }
  // The phase decides first: a paused link download has no stated length yet,
  // and its row must not read "Downloading" beside a Resume button.
  if (download.phase === 'paused') {
    return 'modelChat.gguf.paused';
  }
  if (download.total <= 0) {
    return 'modelChat.gguf.downloadingUnknown';
  }
  return 'modelChat.gguf.downloading';
}

type ControlsProps = {
  readonly fileId: string;
  readonly name: string;
  readonly snapshot: GgufDownloadsSnapshot;
  readonly onDownload: (() => void) | undefined;
  /** Tells one download button from the others on the same screen. */
  readonly downloadLabel?: string;
};

/** One model's state on the device: downloaded, downloading, or ready to download. */
export function GgufDownloadControls({
  fileId,
  name,
  snapshot,
  onDownload,
  downloadLabel,
}: ControlsProps) {
  const { t, i18n } = useTranslation();
  const { confirm, dialog } = useConfirmDialog();
  const record = snapshot.models.find(model => model.fileId === fileId);
  const download = snapshot.download?.fileId === fileId ? snapshot.download : undefined;
  const failure = snapshot.failure?.fileId === fileId ? snapshot.failure : undefined;
  const size = (bytes: number) => formatFileSize(bytes, i18n.language);
  return (
    <>
      {record !== undefined && (
        <>
          <Text className="text-sm">
            {t('modelChat.gguf.downloaded', { size: size(record.sizeBytes) })}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t(modelCapabilityKey(record.tools, record.vision))}
          </Text>
          <Button
            variant="ghost"
            onPress={() => {
              confirm({
                title: t('modelChat.gguf.deleteTitle'),
                message: t('modelChat.gguf.deleteMessage', { name }),
                confirmLabel: t('common.delete'),
                onConfirm: () => {
                  void ggufDownloadActions.remove(fileId);
                },
              });
            }}
          >
            <Text>{t('common.delete')}</Text>
          </Button>
        </>
      )}
      {download !== undefined && (
        <>
          <Text className="text-sm" accessibilityLiveRegion="polite">
            {t(progressKey(download), {
              written: size(download.written),
              total: size(download.total),
            })}
          </Text>
          {download.phase !== 'verifying' && (
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                onPress={() => {
                  if (download.phase === 'paused') {
                    ggufDownloadActions.resume(fileId);
                  } else {
                    ggufDownloadActions.pause(fileId);
                  }
                }}
              >
                <Text>
                  {t(
                    download.phase === 'paused' ? 'modelChat.gguf.resume' : 'modelChat.gguf.pause'
                  )}
                </Text>
              </Button>
              <Button
                variant="ghost"
                onPress={() => {
                  ggufDownloadActions.cancel(fileId);
                }}
              >
                <Text>{t('common.cancel')}</Text>
              </Button>
            </View>
          )}
        </>
      )}
      {record === undefined && download === undefined && onDownload !== undefined && (
        <Button
          variant="outline"
          disabled={snapshot.download !== null}
          onPress={onDownload}
          accessibilityLabel={downloadLabel}
        >
          <Text>{t('modelChat.gguf.download')}</Text>
        </Button>
      )}
      {failure !== undefined && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {t(FAILURE_KEYS[failure.problem])}
        </Text>
      )}
      {dialog}
    </>
  );
}

function DirectLinkForm({ snapshot }: Readonly<{ snapshot: GgufDownloadsSnapshot }>) {
  const { t } = useTranslation();
  const link = useRef('');
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState(0);
  const start = async () => {
    const parsed = readGgufLink(link.current);
    if (!parsed.ok) {
      setError(GGUF_URL_ERROR_KEYS[parsed.problem]);
      return;
    }
    setError(null);
    if (ggufDownloadActions.start(await ggufUrlSource(parsed.value.url, parsed.value.name))) {
      link.current = '';
      setField(previous => previous + 1);
    }
  };
  return (
    <View className="gap-2">
      <FormField
        key={field}
        label={t('modelChat.gguf.url')}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={text => {
          link.current = text;
          setError(null);
        }}
        {...(error === null ? {} : { error: t(error) })}
      />
      <Text className="text-sm text-muted-foreground">{t('modelChat.gguf.urlHelp')}</Text>
      <Button
        variant="outline"
        disabled={snapshot.download !== null}
        onPress={() => {
          void start();
        }}
      >
        <Text>{t('modelChat.gguf.downloadUrl')}</Text>
      </Button>
    </View>
  );
}

/** Downloaded and downloading GGUF models, the catalog entry, and the direct link form. */
export function GgufModelSection({ onBrowse }: Readonly<{ onBrowse: () => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const snapshot = useGgufModels();
  const rows = [
    ...snapshot.models.map(model => ({ fileId: model.fileId, name: model.name })),
    ...(snapshot.download === null ||
    snapshot.models.some(model => model.fileId === snapshot.download?.fileId)
      ? []
      : [{ fileId: snapshot.download.fileId, name: snapshot.download.name }]),
  ];
  const otherFailure =
    snapshot.failure !== null && !rows.some(row => row.fileId === snapshot.failure?.fileId)
      ? snapshot.failure
      : null;
  return (
    <View className="gap-2">
      <Text className="font-semibold">{t('modelChat.gguf.title')}</Text>
      <Text className="text-sm text-muted-foreground">{t('modelChat.gguf.help')}</Text>
      <Button variant="outline" onPress={onBrowse}>
        <PackageSearch size={18} color={colors.foreground} />
        <Text>{t('modelChat.catalog.browse')}</Text>
      </Button>
      {rows.map(row => (
        <View key={row.fileId} className="gap-2 rounded-xl border border-border p-4">
          <Text className="font-semibold">{row.name}</Text>
          <GgufDownloadControls
            fileId={row.fileId}
            name={row.name}
            snapshot={snapshot}
            onDownload={undefined}
          />
        </View>
      ))}
      <DirectLinkForm snapshot={snapshot} />
      {otherFailure !== null && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {t(FAILURE_KEYS[otherFailure.problem])}
        </Text>
      )}
    </View>
  );
}
