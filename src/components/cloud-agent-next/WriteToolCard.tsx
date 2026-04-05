import { FilePlus } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { getFilename } from './toolCardUtils';
import type { ToolPart } from './types';

type WriteToolCardProps = {
  toolPart: ToolPart;
};

type WriteInput = {
  filePath: string;
  content: string;
};

export function WriteToolCard({ toolPart }: WriteToolCardProps) {
  const state = toolPart.state;
  const input = state.input as WriteInput;
  const filename = getFilename(input.filePath);
  const error = state.status === 'error' ? state.error : undefined;

  const lineCount = input.content ? input.content.split('\n').length : 0;
  const byteCount = input.content ? new Blob([input.content]).size : 0;
  const sizeLabel = byteCount > 1024 ? `${(byteCount / 1024).toFixed(1)}KB` : `${byteCount}B`;

  return (
    <ToolCardShell
      icon={FilePlus}
      title="Write"
      subtitle={filename}
      badge={
        <span className="text-muted-foreground shrink-0 text-xs">
          {lineCount} lines, {sizeLabel}
        </span>
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
      {/* Content preview */}
      <div>
        <div className="text-muted-foreground mb-1 text-xs">Content:</div>
        <pre className="bg-background max-h-80 overflow-auto rounded-md p-2 text-xs">
          <code>{input.content || '(empty file)'}</code>
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
        <div className="text-muted-foreground text-xs italic">Writing file...</div>
      )}
      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to write...</div>
      )}
    </ToolCardShell>
  );
}
