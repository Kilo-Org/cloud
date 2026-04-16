import { ScrollView } from 'react-native';
import { Cpu } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { truncateText } from '../tool-card-utils';

export function TaskToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const description = typeof input.description === 'string' ? input.description : undefined;
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;

  const subtitle = description ?? (prompt ? truncateText(prompt, 60) : 'task');

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={Cpu} title="task" subtitle={subtitle} status={part.state.status}>
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
