import { FolderOpen } from 'lucide-react';
import { getDirectoryName } from './toolCardUtils';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';

type ListToolCardProps = {
  toolPart: ToolPart;
};

type ListInput = {
  path: string;
  recursive?: boolean;
};

function parseListOutput(output: string | undefined): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function ListToolCard({ toolPart }: ListToolCardProps) {
  const state = toolPart.state;
  const input = state.input as ListInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const dirName = getDirectoryName(input.path);
  const entries = parseListOutput(output);
  const entryCount = entries.length;

  return (
    <ToolCardShell
      icon={FolderOpen}
      title="List"
      subtitle={dirName}
      status={state.status}
      badge={
        <>
          {input.recursive && (
            <span className="text-muted-foreground shrink-0 text-xs">(recursive)</span>
          )}
          {state.status === 'completed' && (
            <span className="text-muted-foreground shrink-0 text-xs">
              {entryCount} {entryCount === 1 ? 'entry' : 'entries'}
            </span>
          )}
        </>
      }
    >
      {/* Full path if different from display name */}
      {input.path !== dirName && (
        <div className="text-muted-foreground truncate font-mono text-xs">{input.path}</div>
      )}

      {/* Directory listing */}
      {entries.length > 0 && (
        <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
          {entries.map((entry, idx) => (
            <div key={idx} className="truncate font-mono text-xs">
              {entry}
            </div>
          ))}
        </div>
      )}

      {/* Empty directory */}
      {state.status === 'completed' && entries.length === 0 && (
        <div className="text-muted-foreground text-xs italic">Directory is empty</div>
      )}

      {/* Error */}
      {error && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Error:</div>
          <pre className="bg-background overflow-auto rounded-md p-2 text-xs text-red-500">
            <code>{error}</code>
          </pre>
        </div>
      )}

      {/* Running state */}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">Listing directory...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to list...</div>
      )}
    </ToolCardShell>
  );
}
