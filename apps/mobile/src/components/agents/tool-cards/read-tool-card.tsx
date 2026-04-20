import { ScrollView } from 'react-native';
import { Eye } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { getFilename } from '../tool-card-utils';

export function ReadToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const offset = typeof input.offset === 'number' ? input.offset : undefined;
  const limit = typeof input.limit === 'number' ? input.limit : undefined;

  const subtitle = filePath ? getFilename(filePath) : 'read';

  const badge = (() => {
    if (offset === undefined && limit === undefined) {
      return undefined;
    }
    const parts: string[] = [];
    if (offset !== undefined) {
      parts.push(`L${offset}`);
    }
    if (limit !== undefined) {
      parts.push(`${limit} lines`);
    }
    return parts.join(', ');
  })();

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell
      icon={Eye}
      title="read"
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
