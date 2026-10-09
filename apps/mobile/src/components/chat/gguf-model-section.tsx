import { type TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { GGUF_CATALOG, GGUF_URL_ERROR_KEYS, readGgufLink } from '@/lib/chat/gguf-catalog';
import { ggufDownloadActions, ggufUrlSource, useGgufModels } from '@/lib/chat/gguf-models';
import {
  type GgufDownload,
  type GgufDownloadProblem,
  type GgufDownloadsSnapshot,
  type GgufModelRecord,
} from '@/lib/chat/gguf-records';
import { formatFileSize } from '@/lib/format';

const FAILURE_KEYS = {
  space: 'modelChat.gguf.errors.space',
  network: 'modelChat.gguf.errors.network',
  invalidFile: 'modelChat.gguf.errors.invalidFile',
} as const satisfies Record<GgufDownloadProblem, string>;

type RowProps = {
  readonly fileId: string;
  readonly name: string;
  readonly detail: string | undefined;
  readonly snapshot: GgufDownloadsSnapshot;
  readonly onDownload: (() => void) | undefined;
};

function progressKey(download: GgufDownload): string {
  if (download.phase === 'verifying') {
    return 'modelChat.gguf.verifying';
  }
  if (download.total <= 0) {
    return 'modelChat.gguf.downloadingUnknown';
  }
  return download.phase === 'paused' ? 'modelChat.gguf.paused' : 'modelChat.gguf.downloading';
}

function confirmDelete(record: GgufModelRecord, t: TFunction) {
  Alert.alert(
    t('modelChat.gguf.deleteTitle'),
    t('modelChat.gguf.deleteMessage', { name: record.name }),
    [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void ggufDownloadActions.remove(record.fileId);
        },
      },
    ]
  );
}

function GgufModelRow({ fileId, name, detail, snapshot, onDownload }: Readonly<RowProps>) {
  const { t, i18n } = useTranslation();
  const record = snapshot.models.find(model => model.fileId === fileId);
  const download = snapshot.download?.fileId === fileId ? snapshot.download : undefined;
  const failure = snapshot.failure?.fileId === fileId ? snapshot.failure : undefined;
  const size = (bytes: number) => formatFileSize(bytes, i18n.language);
  return (
    <View className="gap-2 rounded-xl border border-border p-4">
      <Text className="font-semibold">{name}</Text>
      {detail !== undefined && <Text className="text-sm text-muted-foreground">{detail}</Text>}
      {record !== undefined && (
        <>
          <Text className="text-sm">
            {t('modelChat.gguf.downloaded', { size: size(record.sizeBytes) })}
          </Text>
          <Text className="text-sm text-muted-foreground">
            {t(record.tools ? 'modelChat.backends.modelTools' : 'modelChat.backends.textOnly')}
          </Text>
          <Button
            variant="ghost"
            onPress={() => {
              confirmDelete(record, t);
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
        <Button variant="outline" disabled={snapshot.download !== null} onPress={onDownload}>
          <Text>{t('modelChat.gguf.download')}</Text>
        </Button>
      )}
      {failure !== undefined && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {t(FAILURE_KEYS[failure.problem])}
        </Text>
      )}
    </View>
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

/** Curated and linked GGUF models: download, pause, resume, cancel, and delete. */
export function GgufModelSection() {
  const { t, i18n } = useTranslation();
  const snapshot = useGgufModels();
  const curated = new Set(GGUF_CATALOG.map(model => model.fileId));
  const linked = [
    ...snapshot.models
      .filter(model => !curated.has(model.fileId))
      .map(model => ({ fileId: model.fileId, name: model.name })),
    ...(snapshot.download === null ||
    curated.has(snapshot.download.fileId) ||
    snapshot.models.some(model => model.fileId === snapshot.download?.fileId)
      ? []
      : [{ fileId: snapshot.download.fileId, name: snapshot.download.name }]),
  ];
  const linkFailure =
    snapshot.failure !== null &&
    !curated.has(snapshot.failure.fileId) &&
    !linked.some(model => model.fileId === snapshot.failure?.fileId)
      ? snapshot.failure
      : null;
  return (
    <View className="gap-2">
      <Text className="font-semibold">{t('modelChat.gguf.title')}</Text>
      <Text className="text-sm text-muted-foreground">{t('modelChat.gguf.help')}</Text>
      {GGUF_CATALOG.map(model => (
        <GgufModelRow
          key={model.fileId}
          fileId={model.fileId}
          name={model.name}
          detail={t('modelChat.gguf.details', {
            size: formatFileSize(model.sizeBytes, i18n.language),
            license: model.license,
          })}
          snapshot={snapshot}
          onDownload={() => {
            ggufDownloadActions.start({ kind: 'catalog', model });
          }}
        />
      ))}
      {linked.map(model => (
        <GgufModelRow
          key={model.fileId}
          fileId={model.fileId}
          name={model.name}
          detail={undefined}
          snapshot={snapshot}
          onDownload={undefined}
        />
      ))}
      <DirectLinkForm snapshot={snapshot} />
      {linkFailure !== null && (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {t(FAILURE_KEYS[linkFailure.problem])}
        </Text>
      )}
    </View>
  );
}
