import { ScrollView } from 'react-native';
import { FolderOpen } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { getDirectoryName } from '../tool-card-utils';

export function ListToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : undefined;
  const path = typeof input.path === 'string' ? input.path : undefined;
  const resolvedPath = filePath ?? path ?? '';

  const subtitle = resolvedPath ? getDirectoryName(resolvedPath) : 'list';

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={FolderOpen} title="list" subtitle={subtitle} status={part.state.status}>
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
