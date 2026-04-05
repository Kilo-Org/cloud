import { FileSearch } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';

type GrepToolCardProps = {
  toolPart: ToolPart;
};

type GrepInput = {
  pattern: string;
  path?: string;
  include?: string;
};

type GrepMatch = {
  file: string;
  line: number;
  content?: string;
};

function parseGrepOutput(output: string | undefined): GrepMatch[] {
  if (!output) return [];
  const lines = output.split('\n').filter(Boolean);
  const matches: GrepMatch[] = [];

  for (const line of lines) {
    // Common grep output format: file:line:content or file:line
    const match = line.match(/^(.+?):(\d+)(?::(.*))?$/);
    if (match) {
      matches.push({
        file: match[1],
        line: parseInt(match[2], 10),
        content: match[3],
      });
    } else {
      // Fallback: treat as file path only
      matches.push({ file: line, line: 0 });
    }
  }

  return matches;
}

function getUniqueFiles(matches: GrepMatch[]): string[] {
  return [...new Set(matches.map(m => m.file))];
}

export function GrepToolCard({ toolPart }: GrepToolCardProps) {
  const state = toolPart.state;
  const input = state.input as GrepInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const matches = parseGrepOutput(output);
  const uniqueFiles = getUniqueFiles(matches);
  const matchCount = matches.length;
  const fileCount = uniqueFiles.length;

  return (
    <ToolCardShell
      icon={FileSearch}
      title="Grep"
      subtitle={input.pattern}
      badge={
        state.status === 'completed' ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {matchCount} in {fileCount} {fileCount === 1 ? 'file' : 'files'}
          </span>
        ) : undefined
      }
      status={state.status}
    >
      {/* Search path and include filter */}
      <div className="text-muted-foreground flex flex-wrap gap-x-3 text-xs">
        {input.path && <span className="truncate font-mono">in: {input.path}</span>}
        {input.include && <span className="truncate font-mono">include: {input.include}</span>}
      </div>

      {/* Results grouped by file */}
      {uniqueFiles.length > 0 && (
        <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
          {uniqueFiles.map((file, idx) => {
            const fileMatches = matches.filter(m => m.file === file);
            return (
              <div key={idx} className="mb-2 last:mb-0">
                <div className="truncate font-mono text-xs font-medium">{file}</div>
                {fileMatches.map((match, midx) => (
                  <div key={midx} className="text-muted-foreground ml-2 truncate font-mono text-xs">
                    <span className="text-blue-400">{match.line}</span>
                    {match.content && <span>: {match.content}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* No matches */}
      {state.status === 'completed' && matches.length === 0 && (
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
        <div className="text-muted-foreground text-xs italic">Searching content...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
