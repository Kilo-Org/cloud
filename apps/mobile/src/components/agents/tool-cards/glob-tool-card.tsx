import { ScrollView } from 'react-native';
import { Search } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';

function countOutputLines(output: string): number {
  if (output.length === 0) {
    return 0;
  }
  return output.split('\n').filter(line => line.trim().length > 0).length;
}

export function GlobToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';

  const subtitle = pattern || 'glob';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const matchCount = output ? countOutputLines(output) : undefined;
  const badge = matchCount !== undefined ? `${matchCount} files` : undefined;

  return (
    <ToolCardShell
      icon={Search}
      title="glob"
      subtitle={subtitle}
      badge={badge}
      status={part.state.status}
    >
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
