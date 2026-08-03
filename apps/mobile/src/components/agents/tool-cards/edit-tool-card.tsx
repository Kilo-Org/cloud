import { useMemo } from 'react';
import { View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';
import { getFilename } from '../tool-card-utils';
import { buildToolDiffModel } from '../tool-diff-model';
import { ToolDiffPreview } from '../tool-diff-preview';

function EditFallbackBody({
  oldString,
  newString,
}: Readonly<{ oldString: string; newString: string }>) {
  return (
    <View className="gap-2">
      {oldString.length > 0 ? (
        <MonoScrollBlock
          content={oldString}
          maxLength={1000}
          containerClassName="rounded bg-red-50 px-2 py-1 dark:bg-red-950"
          textClassName="text-red-700 dark:text-red-400"
        />
      ) : null}
      {newString.length > 0 ? (
        <MonoScrollBlock
          content={newString}
          maxLength={1000}
          containerClassName="rounded bg-green-50 px-2 py-1 dark:bg-green-950"
          textClassName="text-green-700 dark:text-green-400"
        />
      ) : null}
    </View>
  );
}

export function EditToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const oldString = typeof input.oldString === 'string' ? input.oldString : '';
  const newString = typeof input.newString === 'string' ? input.newString : '';

  const subtitle = filePath ? getFilename(filePath) : 'edit';
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const hasChanges = oldString.length > 0 || newString.length > 0;

  const diffModel = useMemo(() => buildToolDiffModel(part), [part]);

  let body: React.ReactNode = null;
  if (diffModel) {
    body = <ToolDiffPreview model={diffModel} partId={part.id} />;
  } else if (hasChanges) {
    body = <EditFallbackBody oldString={oldString} newString={newString} />;
  }

  return (
    <ToolCardShell icon={Pencil} title="edit" subtitle={subtitle} status={part.state.status}>
      {body}
      {error ? (
        <Text selectable={textSelectable} className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
