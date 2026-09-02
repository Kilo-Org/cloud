import { Search } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';
import { getDirectoryName } from './toolCardUtils';
import type { ToolPart } from './types';

type GlobToolCardProps = {
  toolPart: ToolPart;
};

export function GlobToolCard({ toolPart }: GlobToolCardProps) {
  const state = toolPart.state;
  const path = typeof state.input.path === 'string' ? state.input.path : '';
  const pattern = typeof state.input.pattern === 'string' ? state.input.pattern : '';
  const subtitle = [getDirectoryName(path), pattern && `pattern=${pattern}`]
    .filter(Boolean)
    .join(' ');
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={Search}
      title="Glob"
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
        <div className="text-muted-foreground text-xs italic">Searching files...</div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
