import { View } from 'react-native';
import { Terminal } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { SelectableText } from '@/components/ui/selectable-text';

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
  const input = part.state.input;
  const command = typeof input.command === 'string' ? input.command : '';
  const commandText = `$ ${command}`;

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <View className="gap-2">
      {command.length > 0 ? (
        <View className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900">
          <SelectableText className="font-mono text-xs leading-4 text-foreground">
            {commandText}
          </SelectableText>
        </View>
      ) : null}
      {output ? <MonoScrollBlock content={output} textClassName="text-muted-foreground" /> : null}
      {error ? <SelectableText className="text-xs text-destructive">{error}</SelectableText> : null}
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
