import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useAndroidModelDownload } from '@/lib/chat/android-model-download';
import { type LocalModelStatus } from '@/lib/chat/local-models';

/**
 * The user-started download of the Android system model. It appears only
 * while the system reports the model as downloadable, or while a download this
 * row started is running. Nothing starts the download without this button.
 */
export function ModelDownloadControl({ status }: Readonly<{ status: LocalModelStatus }>) {
  const { t } = useTranslation();
  const download = useAndroidModelDownload();
  if (status.provider !== 'android' || download === null) {
    return null;
  }
  const { state, start } = download;
  if (state.kind === 'downloading') {
    const { bytesDownloaded, bytesToDownload } = state;
    const message =
      bytesDownloaded === undefined || bytesToDownload === undefined || bytesToDownload <= 0
        ? t('modelChat.localModels.downloading')
        : t('modelChat.localModels.downloadProgress', {
            percent: Math.min(100, Math.floor((bytesDownloaded / bytesToDownload) * 100)),
          });
    return <AccessibleStatus message={message} tone="status" className="text-sm" />;
  }
  if (status.availability?.status !== 'downloadable') {
    return null;
  }
  return (
    <View className="items-start gap-2 pt-1">
      {state.kind === 'failed' && (
        <AccessibleStatus message={t('modelChat.localModels.downloadFailed')} className="text-sm" />
      )}
      <Button variant="outline" size="sm" onPress={() => void start()}>
        <Text>{t('modelChat.localModels.download')}</Text>
      </Button>
    </View>
  );
}
