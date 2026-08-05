import { View } from 'react-native';
import { Terminal } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { FixedPartRow } from '../fixed-part-row';
import { MonoScrollBlock } from '../mono-scroll-block';
import { useOpenPartDetail } from '../open-part-detail-context';
import { getToolDisplay, toolPartHasDetails } from '../tool-card-display';

/**
 * Sheet body for a bash tool part: the `$ command` block, the output block,
 * and the error. Renders only inside the detail sheet — attachments and the
 * pending/running status line live in `ToolPartDetailBody`.
 */
export function BashToolCardBody({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const input = part.state.input;
  const command = typeof input.command === 'string' ? input.command : '';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <View className="gap-2">
      {command.length > 0 ? (
        <View className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900">
          <Text selectable={textSelectable} className="font-mono text-xs leading-4 text-foreground">
            $ {command}
          </Text>
        </View>
      ) : null}
      {output ? (
        <MonoScrollBlock content={output} maxLength={2000} textClassName="text-muted-foreground" />
      ) : null}
      {error ? (
        <Text selectable={textSelectable} className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function BashToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const openPartDetail = useOpenPartDetail();
  const display = getToolDisplay(part);
  const hasDetails = toolPartHasDetails(part);

  return (
    <FixedPartRow
      icon={Terminal}
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
