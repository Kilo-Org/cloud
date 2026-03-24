import { Globe } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import type { ToolPart } from './types';

type WebSearchToolCardProps = {
  toolPart: ToolPart;
};

type WebSearchInput = {
  query: string;
  numResults?: number;
  type?: string;
};

type SearchResult = {
  title: string;
  url: string;
  author?: string;
  publishedDate?: string;
};

/**
 * Parse Exa search output format.
 * Each result starts with "Title:" and contains URL:, optionally Author: and Published Date:
 */
function parseExaOutput(output: string): SearchResult[] {
  const results: SearchResult[] = [];

  // Split by "Title:" to get individual results (first split is before any title)
  const sections = output.split(/^Title:\s*/m);

  for (const section of sections) {
    if (!section.trim()) continue;

    // Extract title (first line after split)
    const lines = section.split('\n');
    const title = lines[0]?.trim();
    if (!title) continue;

    // Extract URL
    const urlMatch = section.match(/^URL:\s*(.+)$/m);
    const url = urlMatch?.[1]?.trim();
    if (!url) continue;

    // Extract optional fields
    const authorMatch = section.match(/^Author:\s*(.+)$/m);
    const author = authorMatch?.[1]?.trim() || undefined;

    const dateMatch = section.match(/^Published Date:\s*(.+)$/m);
    const publishedDate = dateMatch?.[1]?.trim() || undefined;

    results.push({ title, url, author, publishedDate });
  }

  return results;
}

/**
 * Format a date string for display
 */
function formatDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export function WebSearchToolCard({ toolPart }: WebSearchToolCardProps) {
  const state = toolPart.state;
  const input = state.input as WebSearchInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const results = output ? parseExaOutput(output) : [];
  const resultCount = results.length;

  return (
    <ToolCardShell
      icon={Globe}
      title="WebSearch"
      subtitle={input.query}
      status={state.status}
      badge={
        state.status === 'completed' && resultCount > 0 ? (
          <span className="text-muted-foreground shrink-0 text-xs">
            {resultCount} {resultCount === 1 ? 'result' : 'results'}
          </span>
        ) : undefined
      }
    >
      {/* Results list */}
      {results.length > 0 && (
        <div className="bg-background max-h-60 space-y-2 overflow-auto rounded-md p-2">
          {results.map((result, idx) => (
            <div key={idx} className="text-xs">
              <a
                href={result.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-blue-400 hover:underline"
              >
                {result.title}
              </a>
              <div className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-2">
                {result.author && <span>{result.author}</span>}
                {result.publishedDate && <span>{formatDate(result.publishedDate)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Fallback: show raw output if no results parsed */}
      {state.status === 'completed' && results.length === 0 && output && (
        <div className="bg-background max-h-60 overflow-auto rounded-md p-2">
          <pre className="text-xs whitespace-pre-wrap">{output}</pre>
        </div>
      )}

      {state.status === 'completed' && !output && (
        <div className="text-muted-foreground text-xs italic">No results found</div>
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
        <div className="text-muted-foreground text-xs italic">Searching the web...</div>
      )}

      {/* Pending state */}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
