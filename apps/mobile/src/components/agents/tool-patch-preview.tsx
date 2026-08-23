// Read-only patch preview for patch and apply_patch tool cards.
// Renders one section per parsed file: a header row with the path and an
// Added/Deleted/Updated label, then every `ParsedDiffLine` through the shared
// `DiffLine` component with syntax highlighting. Delete files show their
// header with no rows.
//
// No `onTap`, no `isSelected`, no scroll view — the transcript `FlashList`
// owns all vertical scrolling, and the diff rows are read-only.
//
// The model's file language comes from `languageForPath`; the token-colored
// code stays inside `DiffLine`'s own RNText, so the header row uses plain
// `Text` from `@/components/ui/text`.

import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Text } from '@/components/ui/text';
import { DiffLine } from '@/components/pr-review/diff/diff-line';

import { type ToolPatchFile, type ToolPatchModel } from './tool-patch-model';

type ToolPatchPreviewProps = {
  model: ToolPatchModel;
  partId: string;
};

export function ToolPatchPreview({ model, partId }: Readonly<ToolPatchPreviewProps>) {
  const { t } = useTranslation();
  const operationLabel = {
    add: t('agentChat.toolPatch.operationAdded'),
    delete: t('agentChat.toolPatch.operationDeleted'),
    update: t('agentChat.toolPatch.operationUpdated'),
  } satisfies Record<ToolPatchFile['operation'], string>;

  return (
    <View className="gap-2">
      {model.files.map((file, fileIndex) => (
        <View key={`${partId}:${fileIndex}`}>
          <View className="flex-row items-center gap-2 px-1 py-1">
            <Text className="font-mono text-xs font-medium text-foreground">{file.path}</Text>
            <Text className="text-xs text-muted-foreground">{operationLabel[file.operation]}</Text>
          </View>
          {file.lines.map((line, lineIndex) => (
            <DiffLine
              key={`${partId}:${fileIndex}:${lineIndex}`}
              keyId={`${partId}:${fileIndex}:${lineIndex}`}
              line={line}
              language={file.language}
            />
          ))}
        </View>
      ))}
      {model.truncated ? (
        <Text
          accessibilityLabel={t('monoScrollBlock.contentTruncated')}
          className="mt-1 text-xs text-muted-foreground"
        >
          {t('monoScrollBlock.truncated')}
        </Text>
      ) : null}
    </View>
  );
}
