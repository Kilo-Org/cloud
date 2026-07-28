import { FileSearch } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';

function countOutputLines(output: string): number {
  if (output.length === 0) {
    return 0;
  }
  return output.split('\n').filter(line => line.trim().length > 0).length;
}

export function GrepToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const pattern = typeof input.pattern === 'string' ? input.pattern : '';
  const include = typeof input.include === 'string' ? input.include : undefined;

  let subtitle = pattern || 'grep';
  if (include) {
    subtitle += ` (${include})`;
  }

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const matchCount = output ? countOutputLines(output) : undefined;
  const badge = matchCount !== undefined ? `${matchCount} matches` : undefined;

  return (
    <ToolCardShell
      icon={FileSearch}
      title="grep"
      subtitle={subtitle}
      badge={badge}
      status={part.state.status}
    >
      {output ? (
        <MonoScrollBlock content={output} maxLength={2000} textClassName="text-foreground" />
      ) : null}
      {error ? (
        <Text selectable className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
