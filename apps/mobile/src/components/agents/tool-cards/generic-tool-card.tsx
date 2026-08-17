import { View } from 'react-native';
import { Plug } from '@/components/ui/icons';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

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
 *
 * `inputMaxLength` bounds the input JSON block; it is set by the patch card's
 * fallback so a giant unparseable `patchText` cannot hang the sheet. Every
 * other caller leaves it undefined and keeps today's uncapped behavior.
 */
export function GenericToolCardBody({
  part,
  inputMaxLength,
}: Readonly<{ part: ToolPart; inputMaxLength?: number }>) {
  const input = part.state.input;

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const inputStr = Object.keys(input).length > 0 ? formatInput(input) : undefined;

  return (
    <View className="gap-2">
      {inputStr ? (
        <MonoScrollBlock
          content={inputStr}
          textClassName="text-muted-foreground"
          maxLength={inputMaxLength}
        />
      ) : null}
      {output ? <MonoScrollBlock content={output} textClassName="text-foreground" /> : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
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
