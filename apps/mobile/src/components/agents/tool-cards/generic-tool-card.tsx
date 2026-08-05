import { View } from 'react-native';
import { Plug } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[object]';
  }
}

/**
 * Sheet body for a generic tool part (including unknown tools): the input JSON
 * block when input is non-empty, the output block, and the error. Renders only
 * inside the detail sheet — attachments and the pending/running status line
 * live in `ToolPartDetailBody`.
 */
export function GenericToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const input = part.state.input;

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const inputStr = Object.keys(input).length > 0 ? formatInput(input) : undefined;

  return (
    <View className="gap-2">
      {inputStr ? (
        <MonoScrollBlock
          content={inputStr}
          maxLength={1000}
          textClassName="text-muted-foreground"
        />
      ) : null}
      {output ? (
        <MonoScrollBlock content={output} maxLength={2000} textClassName="text-foreground" />
      ) : null}
      {error ? (
        <Text selectable={textSelectable} className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function GenericToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Plug}
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
