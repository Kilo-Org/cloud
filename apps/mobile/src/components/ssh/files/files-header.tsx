import { type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ScreenHeader } from '@/components/screen-header';
import { ArrowUp, FilePlus, Plug } from '@/components/ui/icons';
import { IconButton } from '@/components/ui/icon-button';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type FilesHeaderProps = Readonly<{
  title: string;
  subtitle: string | undefined;
  backFallback: Href;
  /** Whether the session finished loading, so its forwards can be opened. */
  sessionReady: boolean;
  /** Whether the directory is known, so its actions can act on it. */
  folderReady: boolean;
  onForwards: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
}>;

/** The files screen's title bar and its three folder actions. */
export function FilesHeader({
  title,
  subtitle,
  backFallback,
  sessionReady,
  folderReady,
  onForwards,
  onNewFolder,
  onUpload,
}: FilesHeaderProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();

  return (
    <ScreenHeader
      title={title}
      subtitle={subtitle}
      backFallback={backFallback}
      headerRight={
        <View className="flex-row items-center">
          <IconButton
            accessibilityLabel={t('ssh.forwards.title')}
            disabled={!sessionReady}
            onPress={onForwards}
          >
            <Plug size={20} color={colors.foreground} />
          </IconButton>
          <IconButton
            accessibilityLabel={t('ssh.files.newFolder')}
            disabled={!folderReady}
            onPress={onNewFolder}
          >
            <FilePlus size={20} color={colors.foreground} />
          </IconButton>
          <IconButton
            accessibilityLabel={t('ssh.files.upload')}
            disabled={!folderReady}
            onPress={onUpload}
          >
            <ArrowUp size={20} color={colors.foreground} />
          </IconButton>
        </View>
      }
      headerRightWidth={144}
    />
  );
}
