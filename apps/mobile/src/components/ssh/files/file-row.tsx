import { type SftpEntry } from '@kilocode/react-native-ssh';
import { type TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { ChevronRight, FileIcon, FolderOpen, ImageIcon } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { formatDate, formatFileSize } from '@/lib/format';
import { type PreviewKind, previewKindOf } from '@/lib/ssh/files/paths';

type FileRowProps = Readonly<{
  entry: SftpEntry;
  onPress: () => void;
  onLongPress: () => void;
}>;

/** One directory entry: what it is, its size and when it changed. */
export function FileRow({ entry, onPress, onLongPress }: FileRowProps) {
  const { t, i18n } = useTranslation();
  const colors = useThemeColors();
  const directory = entry.kind === 'directory';
  const preview = previewKindOf(entry);
  const Icon = iconOf(directory, preview);
  const details =
    entry.modifiedUnix === null ? [] : [modifiedLabel(entry.modifiedUnix, i18n.language)];
  if (!directory && entry.kind !== 'other') {
    details.unshift(formatFileSize(entry.size, i18n.language));
  }
  const meaning = meaningOf(t, directory, preview);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[entry.name, meaning, ...details].join(', ')}
      accessibilityHint={directory ? t('ssh.files.openFolderHint') : t('ssh.files.openFileHint')}
      className="flex-row items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 active:opacity-70"
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View className="h-9 w-9 items-center justify-center rounded-lg bg-secondary">
        <Icon size={18} color={colors.mutedForeground} />
      </View>
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
          {details.length === 0 ? meaning : details.join(' · ')}
        </Text>
      </View>
      {directory ? <ChevronRight size={16} color={colors.mutedForeground} /> : null}
    </Pressable>
  );
}

function iconOf(directory: boolean, preview: PreviewKind | null) {
  if (directory) {
    return FolderOpen;
  }
  return preview === 'image' ? ImageIcon : FileIcon;
}

function meaningOf(t: TFunction, directory: boolean, preview: PreviewKind | null): string {
  if (directory) {
    return t('ssh.files.kindFolder');
  }
  if (preview === 'image') {
    return t('ssh.files.kindImage');
  }
  return t('common.file');
}

function modifiedLabel(unixSeconds: number, language: string): string {
  return formatDate(new Date(unixSeconds * 1000), language, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
