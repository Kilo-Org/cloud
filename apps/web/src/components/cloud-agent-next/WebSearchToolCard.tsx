import { Code2, Globe } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolCodeBlock } from './ToolOutput';
import { extractSearchUrls } from './tool-search';
import type { ToolPart } from './types';

type WebSearchToolCardProps = {
  toolPart: ToolPart;
};

export function WebSearchToolCard({ toolPart }: WebSearchToolCardProps) {
  const state = toolPart.state;
  const query = typeof state.input.query === 'string' ? state.input.query : '';
  const output = state.status === 'completed' ? state.output : undefined;
  const error = state.status === 'error' ? state.error : undefined;
  const urls = extractSearchUrls(output);
  const isCodeSearch = toolPart.tool === 'codesearch';

  return (
    <ToolCardShell
      icon={isCodeSearch ? Code2 : Globe}
      title={isCodeSearch ? 'CodeSearch' : 'WebSearch'}
      subtitle={query}
      status={state.status}
    >
      {urls.length > 0 && (
        <ul className="max-h-60 space-y-1 overflow-auto text-xs">
          {urls.map(url => (
            <li key={url}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-sm break-all hover:underline focus-visible:ring-2 focus-visible:outline-none"
              >
                {url}
              </a>
            </li>
          ))}
        </ul>
      )}

      {state.status === 'completed' && urls.length === 0 && (
        <div className="text-muted-foreground text-xs italic">
          {output?.trim() ? 'No links found in search output' : 'No results found'}
        </div>
      )}

      {error && <ToolCodeBlock content={error} label="Error" className="text-destructive" />}

      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs italic">
          {isCodeSearch ? 'Searching code...' : 'Searching the web...'}
        </div>
      )}

      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs italic">Waiting to search...</div>
      )}
    </ToolCardShell>
  );
}
