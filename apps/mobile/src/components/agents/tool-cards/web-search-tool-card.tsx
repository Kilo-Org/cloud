import { View } from 'react-native';
import { Globe } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

/**
 * Sheet body for a websearch/codesearch/webfetch tool part: the output block
 * and the error. The query/url lives in the sheet title. Renders only inside
 * the detail sheet — attachments and the pending/running status line live in
 * `ToolPartDetailBody`.
 */
export function WebSearchToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <View className="gap-2">
      {output ? <MonoScrollBlock content={output} textClassName="text-foreground" /> : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
    </View>
  );
}

export function WebSearchToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Globe}
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
