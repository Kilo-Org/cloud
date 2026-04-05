import { Pencil } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';
import { getFilename } from './toolCardUtils';

type EditToolCardProps = {
  toolPart: ToolPart;
};

type EditInput = {
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

export function EditToolCard({ toolPart }: EditToolCardProps) {
  const state = toolPart.state;
  const input = state.input as EditInput;
  const filename = getFilename(input.filePath);
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={Pencil}
      title="Edit"
      subtitle={filename}
      badge={
        input.replaceAll ? (
          <span className="text-muted-foreground shrink-0 text-xs">(replace all)</span>
        ) : undefined
      }
      status={state.status}
    >
      {/* Full path if different from filename */}
      {input.filePath !== filename && (
        <div>
          <div className="text-muted-foreground text-xs">Full path:</div>
          <div className="text-muted-foreground truncate font-mono text-xs">{input.filePath}</div>
        </div>
      )}
      {/* Old string */}
      <div>
        <div className="text-muted-foreground mb-1 text-xs">Old:</div>
        <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs text-red-400">
          <code>{input.oldString || '(empty)'}</code>
        </pre>
      </div>
      {/* New string */}
      <div>
        <div className="text-muted-foreground mb-1 text-xs">New:</div>
        <pre className="bg-background max-h-40 overflow-auto rounded-md p-2 text-xs text-green-400">
          <code>{input.newString || '(empty)'}</code>
        </pre>
      </div>
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
        <div className="text-muted-foreground text-xs italic">Editing file...</div>
      )}
      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to edit...</div>
      )}
    </ToolCardShell>
  );
}
