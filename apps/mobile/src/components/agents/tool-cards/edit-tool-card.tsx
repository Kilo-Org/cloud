import { useMemo } from 'react';
import { View } from 'react-native';
import { Pencil } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
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
          containerClassName="rounded bg-red-50 px-2 py-1 dark:bg-red-950"
          textClassName="text-red-700 dark:text-red-400"
        />
      ) : null}
      {newString.length > 0 ? (
        <MonoScrollBlock
          content={newString}
          containerClassName="rounded bg-green-50 px-2 py-1 dark:bg-green-950"
          textClassName="text-green-700 dark:text-green-400"
        />
      ) : null}
    </View>
  );
}

/**
 * Sheet body for an edit tool part: the diff preview when the model exists,
 * else the old/new fallback blocks for whichever string is non-empty, plus the
 * error. Renders only inside the detail sheet — attachments and the
 * pending/running status line live in `ToolPartDetailBody`.
 */
export function EditToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const oldString = typeof input.oldString === 'string' ? input.oldString : '';
  const newString = typeof input.newString === 'string' ? input.newString : '';

  const error = part.state.status === 'error' ? part.state.error : undefined;

  const diffModel = useMemo(() => buildToolDiffModel(part), [part]);

  let body: React.ReactNode = null;
  if (diffModel) {
    body = <ToolDiffPreview model={diffModel} partId={part.id} />;
  } else if (oldString.length > 0 || newString.length > 0) {
    body = <EditFallbackBody oldString={oldString} newString={newString} />;
  }

  return (
    <View className="gap-2">
      {body}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function EditToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Pencil}
      label={display.subtitle ?? display.title}
      status={part.state.status}
      accessibilityLabel={`${display.subtitle ?? display.title} tool, ${part.state.status}`}
      onPress={
        hasDetails && openPartDetail
          ? () => {
              openPartDetail(part.id);
            }
          : undefined
      }
    />
  );
}
