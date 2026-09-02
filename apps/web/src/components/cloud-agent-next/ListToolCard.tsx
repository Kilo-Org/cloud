import { FolderOpen } from 'lucide-react';
import { getDirectoryName } from './toolCardUtils';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock, ToolMarkdown } from './ToolOutput';
import type { ToolPart } from './types';

type ListToolCardProps = {
  toolPart: ToolPart;
};

export function ListToolCard({ toolPart }: ListToolCardProps) {
  const state = toolPart.state;
  const path = typeof state.input.path === 'string' ? state.input.path : '';
  const dirName = getDirectoryName(path);
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={FolderOpen}
      title="List"
      subtitle={<span title={path}>{dirName}</span>}
      status={state.status}
      badge={
        state.input.recursive === true ? (
          <span className="text-muted-foreground shrink-0 text-xs">(recursive)</span>
        ) : undefined
      }
    >
      {path && path !== dirName && (
        <div className="text-muted-foreground font-mono text-xs break-all">{path}</div>
      )}

      {output?.trim() && <ToolMarkdown content={output} />}

      {state.status === 'completed' && !output?.trim() && (
        <div className="text-muted-foreground text-xs italic">No entries returned</div>
      )}

      {error && <ToolCodeBlock content={error} label="Error" className="text-destructive" />}

      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Listing directory...</div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to list...</div>
      )}
    </ToolCardShell>
  );
}
