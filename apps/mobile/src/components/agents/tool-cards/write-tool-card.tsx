import { ScrollView } from 'react-native';
import { FilePlus } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { getFilename, truncateText } from '../tool-card-utils';

export function WriteToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const content = typeof input.content === 'string' ? input.content : '';

  const subtitle = filePath ? getFilename(filePath) : 'write';
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={FilePlus} title="write" subtitle={subtitle} status={part.state.status}>
      {content.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text selectable className="font-mono text-xs leading-4 text-foreground">
            {truncateText(content, 2000)}
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
