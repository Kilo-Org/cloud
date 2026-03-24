import { Eye } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { getFilename } from './toolCardUtils';
import type { ToolPart } from './types';

type ReadToolCardProps = {
  toolPart: ToolPart;
};

type ReadInput = {
  filePath: string;
  offset?: number;
  limit?: number;
};

function getLineRange(input: ReadInput): string | null {
  if (input.offset === undefined && input.limit === undefined) {
    return null;
  }
  const start = (input.offset ?? 0) + 1; // Convert 0-based to 1-based
  if (input.limit !== undefined) {
    const end = start + input.limit - 1;
    return `${start}-${end}`;
  }
  return `${start}+`;
}

export function ReadToolCard({ toolPart }: ReadToolCardProps) {
  const state = toolPart.state;
  const input = state.input as ReadInput;
  const filename = getFilename(input.filePath);
  const lineRange = getLineRange(input);
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const displayLabel = lineRange ? `${filename}:${lineRange}` : filename;

  return (
    <ToolCardShell icon={Eye} title="Read" subtitle={displayLabel} status={state.status}>
      {input.filePath !== filename && (
        <div>
          <div className="text-muted-foreground text-xs">Full path:</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{input.filePath}</div>
        </div>
      )}

      {output !== undefined && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Content:</div>
          <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
            <code>{output || '(empty file)'}</code>
          </pre>
        </div>
      )}

      {error && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Error:</div>
          <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
            <code>{error}</code>
          </pre>
        </div>
      )}

      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Reading file...</div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to read...</div>
      )}
    </ToolCardShell>
  );
}
