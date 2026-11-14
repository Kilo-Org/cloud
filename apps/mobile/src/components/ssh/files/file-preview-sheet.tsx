import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { ImageViewer } from '@/components/ui/image-viewer';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { transferErrorMessage } from '@/lib/ssh/files/error-copy';

export type FilePreview = Readonly<{
  name: string;
  kind: 'text' | 'image';
  loading: boolean;
  text: string | null;
  uri: string | null;
  /** The core's failure category when the file could not be fetched. */
  code: string | null;
}>;

type FilePreviewSheetProps = Readonly<{
  preview: FilePreview | null;
  onClose: () => void;
  onShare: () => void;
  onRetry: () => void;
}>;

/**
 * A remote file read in place: text under a bounded sheet, an image through the
 * app's zooming viewer. Anything larger than the preview limit is shared
 * instead, which is why this surface never streams.
 */
export function FilePreviewSheet({ preview, onClose, onShare, onRetry }: FilePreviewSheetProps) {
  const { t } = useTranslation();
  if (preview === null) {
    return null;
  }

  if (preview.kind === 'image' && preview.uri !== null) {
    return (
      <ImageViewer
        visible
        uri={preview.uri}
        filename={preview.name}
        onShare={onShare}
        onClose={onClose}
      />
    );
  }

  return (
    <Sheet visible snapPoints={['75%']} onClose={onClose}>
      <View className="flex-1 gap-2 px-4 pb-2">
        <View className="flex-row items-center gap-2">
          <Text
            accessibilityRole="header"
            className="min-w-0 flex-1 text-base font-semibold text-foreground"
            numberOfLines={1}
          >
            {preview.name}
          </Text>
          <Button
            variant="outline"
            size="sm"
            className={STATE_ACTION_CLASS}
            disabled={preview.loading}
            onPress={onShare}
          >
            <Text>{t('common.share', { title: preview.name })}</Text>
          </Button>
        </View>

        {preview.loading ? (
          <View className="flex-1 items-center justify-center gap-3">
            <ActivityIndicator />
            <Text className="text-sm text-muted-foreground">{t('ssh.files.previewLoading')}</Text>
          </View>
        ) : null}
        {!preview.loading && preview.code !== null ? (
          <View className="flex-1 items-center justify-center gap-3">
            <AccessibleStatus message={transferErrorMessage(t, preview.code)} className="text-sm" />
            <Button variant="outline" className={STATE_ACTION_CLASS} onPress={onRetry}>
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        ) : null}
        {!preview.loading && preview.code === null ? (
          <ScrollView className="flex-1" contentContainerClassName="pb-4">
            <Text selectable className="font-mono text-xs leading-[1rem] text-foreground">
              {preview.text ?? ''}
            </Text>
          </ScrollView>
        ) : null}
      </View>
    </Sheet>
  );
}
