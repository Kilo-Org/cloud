import { View } from 'react-native';
import { Plug } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';
import { getGenericToolTitle } from '../tool-card-utils';

function formatInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return '[object]';
  }
}

export function GenericToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const stateTitle =
    part.state.status === 'running' || part.state.status === 'completed'
      ? part.state.title
      : undefined;
  const subtitle = getGenericToolTitle(part.tool, stateTitle, input);

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const inputStr = Object.keys(input).length > 0 ? formatInput(input) : undefined;
  const hasExpandedContent = Boolean(inputStr) || Boolean(output) || Boolean(error);

  return (
    <ToolCardShell
      icon={Plug}
      title={part.tool}
      subtitle={subtitle}
      status={part.state.status}
      part={part}
    >
      {hasExpandedContent ? (
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
            <Text selectable className="text-xs text-destructive">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ToolCardShell>
  );
}
