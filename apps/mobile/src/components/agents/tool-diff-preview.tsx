// Read-only diff preview for edit tool cards.
// Renders every `ParsedDiffLine` from the model through the shared
// `DiffLine` component with syntax highlighting.
//
// Does not use `parsePatch` because the tool inputs are not unified
// patches. No hunk headers, no selection handlers, no scroll view —
// the transcript `FlashList` owns all vertical scrolling.

import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { DiffLine } from '@/components/pr-review/diff/diff-line';

import { type ToolDiffModel } from './tool-diff-model';

type ToolDiffPreviewProps = {
  model: ToolDiffModel;
  partId: string;
};

export function ToolDiffPreview({ model, partId }: Readonly<ToolDiffPreviewProps>) {
  return (
    <View className="gap-0">
      {model.lines.map((line, index) => (
        <DiffLine
          key={`${partId}:${index}`}
          keyId={`${partId}:${index}`}
          line={line}
          language={model.language}
        />
      ))}
      {model.truncated ? (
        <Text accessibilityLabel="Content truncated" className="mt-1 text-xs text-muted-foreground">
          Truncated
        </Text>
      ) : null}
    </View>
  );
}
