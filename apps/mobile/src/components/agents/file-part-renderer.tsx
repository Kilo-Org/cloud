import { View } from 'react-native';
import { File as FileIcon } from '@/components/ui/icons';
import { type FilePart } from '@kilocode/cloud-agent-sdk';

import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type FilePartRendererProps = {
  part: FilePart;
};

export function FilePartRenderer({ part }: Readonly<FilePartRendererProps>) {
  const colors = useThemeColors();
  const isImage = part.mime.startsWith('image/');

  if (isImage && part.url) {
    return (
      <View className="my-1 overflow-hidden rounded-lg">
        {/* An agent's image output carries meaning, so it is labeled rather
            than decorative. `accessible` is required: expo-image defaults it
            to false, so `alt` alone leaves the image unreachable. */}
        <Image
          source={{ uri: part.url }}
          className="aspect-video w-full"
          contentFit="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel={part.filename ? `Image output, ${part.filename}` : 'Image output'}
        />
        {part.filename ? (
          <Text className="mt-1 text-xs text-muted-foreground">{part.filename}</Text>
        ) : null}
      </View>
    );
  }

  return (
    <View className="my-1 flex-row items-center gap-2 rounded-lg bg-neutral-100 px-3 py-2 dark:bg-neutral-900">
      <FileIcon size={14} color={colors.mutedForeground} />
      <Text className="text-sm text-muted-foreground" numberOfLines={1}>
        {part.filename ?? 'File'}
      </Text>
    </View>
  );
}
