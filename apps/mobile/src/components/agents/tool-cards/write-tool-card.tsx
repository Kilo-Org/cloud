import { useMemo } from 'react';
import { FilePlus } from 'lucide-react-native';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';

import { Text } from '@/components/ui/text';

import { useTranscriptTextSelectable } from '../bubble-text-selection-context';
import { MonoScrollBlock } from '../mono-scroll-block';
import { ToolCardShell } from '../tool-card-shell';
import { getFilename } from '../tool-card-utils';
import { buildToolDiffModel } from '../tool-diff-model';
import { ToolDiffPreview } from '../tool-diff-preview';

export function WriteToolCard({ part }: Readonly<{ part: ToolPart }>) {
  const textSelectable = useTranscriptTextSelectable();
  const input = part.state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const content = typeof input.content === 'string' ? input.content : '';

  const subtitle = filePath ? getFilename(filePath) : 'write';
  const error = part.state.status === 'error' ? part.state.error : undefined;

  const diffModel = useMemo(() => buildToolDiffModel(part), [part]);

  let body: React.ReactNode = null;
  if (diffModel) {
    body = <ToolDiffPreview model={diffModel} partId={part.id} />;
  } else if (content.length > 0) {
    body = <MonoScrollBlock content={content} maxLength={2000} textClassName="text-foreground" />;
  }

  return (
    <ToolCardShell icon={FilePlus} title="write" subtitle={subtitle} status={part.state.status}>
      {body}
      {error ? (
        <Text selectable={textSelectable} className="text-xs text-destructive">
          {error}
        </Text>
      ) : null}
    </ToolCardShell>
  );
}
