import { ScrollView, View } from 'react-native';
import { Plug } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

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
    <ToolCardShell icon={Plug} title={part.tool} subtitle={subtitle} status={part.state.status}>
      {hasExpandedContent ? (
        <View className="gap-2">
          {inputStr ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable className="font-mono text-xs leading-4 text-muted-foreground">
                {inputStr.slice(0, 1000)}
              </Text>
            </ScrollView>
          ) : null}
          {output ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable className="font-mono text-xs leading-4 text-foreground">
                {output.slice(0, 2000)}
              </Text>
            </ScrollView>
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
