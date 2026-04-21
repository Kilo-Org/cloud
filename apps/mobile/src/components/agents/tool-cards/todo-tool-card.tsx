import { ScrollView } from 'react-native';
import { ListTodo } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';

export function TodoToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const isWrite = part.tool === 'todowrite';
  const subtitle = isWrite ? 'Update todos' : 'Read todos';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={ListTodo} title={part.tool} subtitle={subtitle} status={part.state.status}>
      {output ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable className="font-mono text-xs leading-4 text-foreground">
            {output.slice(0, 2000)}
          </Text>
        </ScrollView>
      ) : null}
      {error ? (
        <Text selectable className="text-xs text-red-500">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
