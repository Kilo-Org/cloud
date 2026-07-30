import { FilePlus } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';
import { getFilename } from '../tool-card-utils';

export function WriteToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const content = typeof input.content === 'string' ? input.content : '';

  const subtitle = filePath ? getFilename(filePath) : 'write';
  const error = part.state.status === 'error' ? part.state.error : undefined;

  return (
    <ToolCardShell icon={FilePlus} title="write" subtitle={subtitle} status={part.state.status}>
      {content.length > 0 ? (
        <MonoScrollBlock content={content} maxLength={2000} textClassName="text-foreground" />
      ) : null}
      {error ? (
        <Text selectable className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
