import { useMemo } from 'react';
import { View } from 'react-native';
import { FilePlus } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';
import { buildToolDiffModel } from '../tool-diff-model';
import { ToolDiffPreview } from '../tool-diff-preview';

/**
 * Sheet body for a write tool part: the diff preview when the model exists,
 * else the content block, plus the error. Renders only inside the detail sheet
 * — attachments and the pending/running status line live in
 * `ToolPartDetailBody`.
 */
export function WriteToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const content = typeof input.content === 'string' ? input.content : '';

  const error = part.state.status === 'error' ? part.state.error : undefined;

  const diffModel = useMemo(() => buildToolDiffModel(part), [part]);

  let body: React.ReactNode = null;
  if (diffModel) {
    body = <ToolDiffPreview model={diffModel} partId={part.id} />;
  } else if (content.length > 0) {
    body = <MonoScrollBlock content={content} textClassName="text-foreground" />;
  }

  return (
    <View className="gap-2">
      {body}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function WriteToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={FilePlus}
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
