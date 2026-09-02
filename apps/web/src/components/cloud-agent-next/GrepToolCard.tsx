import { FileSearch } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';
import { getDirectoryName } from './toolCardUtils';

type GrepToolCardProps = {
  toolPart: ToolPart;
};

export function GrepToolCard({ toolPart }: GrepToolCardProps) {
  const state = toolPart.state;
  const input = state.input;
  const path = typeof input.path === 'string' ? input.path : '';
  const args: string[] = [];
  if (typeof input.pattern === 'string' && input.pattern) args.push(`pattern=${input.pattern}`);
  if (typeof input.include === 'string' && input.include) args.push(`include=${input.include}`);
  const subtitle = [getDirectoryName(path), ...args].join(' ');
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={FileSearch}
      title="Grep"
      subtitle={<span title={path}>{subtitle}</span>}
      status={state.status}
    >
      {path && <div className="text-muted-foreground font-mono text-xs break-all">{path}</div>}

      {output?.trim() && <ToolMarkdown content={output} />}

      {state.status === 'completed' && !output?.trim() && (
        <div className="text-muted-foreground text-xs italic">No matches found</div>
      )}

      {error && <ToolCodeBlock content={error} label="Error" className="text-destructive" />}

      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Searching content...</div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
