import { ScrollView, View } from 'react-native';
import { Terminal } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { truncateText } from '../tool-card-utils';

export function BashToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : undefined;

  const subtitle = description ?? (command ? truncateText(command, 60) : 'bash');

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const hasExpandedContent = command.length > 60 || Boolean(output) || Boolean(error);

  return (
    <ToolCardShell icon={Terminal} title="bash" subtitle={subtitle} status={part.state.status}>
      {hasExpandedContent ? (
        <View className="gap-2">
          {command.length > 0 ? (
            <View className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900">
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Text selectable className="font-mono text-xs leading-4 text-foreground">
                  $ {command}
                </Text>
              </ScrollView>
            </View>
          ) : null}
          {output ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text selectable className="font-mono text-xs leading-4 text-muted-foreground">
                {output.slice(0, 2000)}
              </Text>
            </ScrollView>
          ) : null}
          {error ? (
            <Text selectable className="text-xs text-red-500">
              {error}
            </Text>
          ) : null}
        </View>
      ) : null}
    </ToolCardShell>
  );
}
