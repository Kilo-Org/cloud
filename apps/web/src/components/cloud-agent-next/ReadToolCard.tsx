import { Eye } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock } from './ToolOutput';
import { getFilename } from './toolCardUtils';
import type { ToolPart } from './types';

type ReadToolCardProps = {
  toolPart: ToolPart;
};

export function ReadToolCard({ toolPart }: ReadToolCardProps) {
  const state = toolPart.state;
  const input = state.input;
  const filePath = typeof input.filePath === 'string' ? input.filePath : '';
  const filename = getFilename(filePath);
  const args: string[] = [];
  if (typeof input.offset === 'number') args.push(`offset=${input.offset}`);
  if (typeof input.limit === 'number') args.push(`limit=${input.limit}`);
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={Eye}
      title="Read"
      subtitle={<span title={filePath}>{[filename, ...args].filter(Boolean).join(' ')}</span>}
      status={state.status}
    >
      {filePath !== filename && (
        <div className="text-muted-foreground font-mono text-xs break-all">{filePath}</div>
      )}

      {output !== undefined &&
        (output ? (
          <ToolCodeBlock content={output} label="Content" />
        ) : (
          <div className="text-muted-foreground text-xs italic">(empty file)</div>
        ))}

      {error && <ToolCodeBlock content={error} label="Error" className="text-destructive" />}

      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Reading file...</div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to read...</div>
      )}
    </ToolCardShell>
  );
}
