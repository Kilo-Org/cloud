import { ScrollView } from 'react-native';
import { Globe } from 'lucide-react-native';
import { type ToolPart } from 'cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { ToolCardShell } from '../tool-card-shell';
import { truncateText } from '../tool-card-utils';

export function WebSearchToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const query = typeof input.query === 'string' ? input.query : undefined;
  const url = typeof input.url === 'string' ? input.url : undefined;

  let subtitle = part.tool;
  if (query) {
    subtitle = truncateText(query, 60);
  } else if (url) {
    subtitle = truncateText(url, 60);
  }

  const output = part.state.status === 'completed' ? part.state.output : undefined;
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={Globe} title={part.tool} subtitle={subtitle} status={part.state.status}>
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
