import { Search } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';

type GlobToolCardProps = {
  toolPart: ToolPart;
};

type GlobInput = {
  pattern: string;
  path?: string;
};

function parseGlobOutput(output: string | undefined): string[] {
  if (!output) return [];
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function GlobToolCard({ toolPart }: GlobToolCardProps) {
  const state = toolPart.state;
  const input = state.input as GlobInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const files = parseGlobOutput(output);
  const fileCount = files.length;

  return (
    <ToolCardShell
      icon={Search}
      title="Glob"
      subtitle={input.pattern}
      badge={
        state.status === 'completed' ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        ) : undefined
      }
      status={state.status}
    >
      {/* Search path if specified */}
      {input.path && (
        <div className="text-muted-foreground truncate font-mono text-xs">in: {input.path}</div>
      )}
      {/* Results */}
      {files.length > 0 && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs">Matches:</div>
          <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
            {files.map((file, idx) => (
              <div key={idx} className="truncate font-mono text-xs">
                {file}
              </div>
            ))}
          </div>
        </div>
      )}
      {/* No matches */}
      {state.status === 'completed' && files.length === 0 && (
        <div className="text-muted-foreground text-xs italic">No matches found</div>
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
        <div className="text-muted-foreground text-xs italic">Searching files...</div>
      )}
      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
