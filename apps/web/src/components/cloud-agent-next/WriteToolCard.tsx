import { FilePlus } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolDiagnostics, ToolDiff, ToolDiffStats, ToolFilePath } from './ToolDiff';
import { ToolCodeBlock } from './ToolOutput';
import { getUnifiedPatch, readFileToolMetadata } from './toolDiffUtils';
import type { ToolPart } from './types';

type WriteToolCardProps = {
  toolPart: ToolPart;
};

export function WriteToolCard({ toolPart }: WriteToolCardProps) {
  const state = toolPart.state;
  const input = state.input;
  const metadata = readFileToolMetadata(state.status === 'pending' ? undefined : state.metadata);
  const filePath =
    metadata.filediff?.file ??
    (typeof input.filePath === 'string' && input.filePath.trim() ? input.filePath : undefined);
  const content = typeof input.content === 'string' ? input.content : undefined;
  const patch = getUnifiedPatch(metadata.filediff?.patch);
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={FilePlus}
      title="Write"
      subtitle={filePath ? <ToolFilePath filePath={filePath} /> : undefined}
      badge={<ToolDiffStats {...metadata.filediff} />}
      status={state.status}
    >
      {filePath && (
        <div className="text-muted-foreground font-mono text-xs break-all">{filePath}</div>
      )}
      <ToolDiff
        patch={patch}
        original={content !== undefined ? '' : undefined}
        modified={content}
        filePath={filePath}
        textLabel="Written content (compared with an empty file)"
      />
      {patch === undefined &&
        content === undefined &&
        state.status === 'completed' &&
        state.output.trim() && <ToolCodeBlock content={state.output} label="Output" />}
      <ToolDiagnostics diagnostics={metadata.diagnostics} filePath={filePath} />
      {error && (
        <pre className="bg-background text-destructive max-h-40 overflow-auto rounded-md p-2 text-xs">
          <code>{error}</code>
        </pre>
      )}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs">Writing file…</div>
      )}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs">Waiting to write…</div>
      )}
    </ToolCardShell>
  );
}
