'use client';

import { useState } from 'react';
import { ChevronDown, Loader2, XCircle, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ToolPart } from './types';

type WebSearchToolCardProps = {
  toolPart: ToolPart;
};

type WebSearchInput = {
  query: string;
  numResults?: number;
  type?: string;
};

function getStatusIndicator(status: 'pending' | 'running' | 'completed' | 'error') {
  switch (status) {
    case 'error':
      return <XCircle className="h-4 w-4 shrink-0 text-red-500" />;
    case 'completed':
      return <Globe className="text-muted-foreground h-4 w-4 shrink-0" />;
    case 'pending':
    case 'running':
    default:
      return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-500" />;
  }
}

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
  const [isExpanded, setIsExpanded] = useState(false);

  const state = toolPart.state;
  const input = state.input as WebSearchInput;
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  const results = output ? parseExaOutput(output) : [];
  const resultCount = results.length;

  return (
    <div className="border-muted bg-muted/30 rounded-md border">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {getStatusIndicator(state.status)}
        <code className="min-w-0 flex-1 truncate text-sm">{input.query}</code>
        {state.status === 'completed' && resultCount > 0 && (
          <span className="text-muted-foreground shrink-0 text-xs">
            {resultCount} {resultCount === 1 ? 'result' : 'results'}
          </span>
        )}
        <ChevronDown
          className={cn(
            'text-muted-foreground h-4 w-4 shrink-0 transition-transform',
            isExpanded && 'rotate-180'
          )}
        />
      </button>

      {isExpanded && (
        <div className="border-muted space-y-2 border-t px-3 py-2">
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
        </div>
      )}
    </div>
  );
}
