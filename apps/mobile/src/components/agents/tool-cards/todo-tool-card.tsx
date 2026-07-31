import { ListTodo } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';

export function TodoToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const isWrite = part.tool === 'todowrite';
  const subtitle = isWrite ? 'Update todos' : 'Read todos';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={ListTodo} title={part.tool} subtitle={subtitle} status={part.state.status}>
      {output ? (
        <MonoScrollBlock content={output} maxLength={2000} textClassName="text-foreground" />
      ) : null}
      {error ? (
        <Text selectable={textSelectable} className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
