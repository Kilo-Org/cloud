import { Cpu } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';
import { truncateText } from '../tool-card-utils';

export function TaskToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const input = part.state.input;
  const description = typeof input.description === 'string' ? input.description : undefined;
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;

  const subtitle = description ?? (prompt ? truncateText(prompt, 60) : 'task');

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={Cpu} title="task" subtitle={subtitle} status={part.state.status}>
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
