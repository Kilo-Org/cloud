import { Pencil } from 'lucide-react';
import type { ToolPart } from './types';
import { ToolCardShell } from './ToolCardShell';
import { ToolDiagnostics, ToolDiff, ToolDiffStats, ToolFilePath } from './ToolDiff';
import { ToolCodeBlock } from './ToolOutput';
import { getUnifiedPatch, readFileToolMetadata } from './toolDiffUtils';

type EditToolCardProps = {
  toolPart: ToolPart;
};

export function EditToolCard({ toolPart }: EditToolCardProps) {
  const state = toolPart.state;
  const input = state.input;
  const metadata = readFileToolMetadata(state.status === 'pending' ? undefined : state.metadata);
  const filePath =
    metadata.filediff?.file ??
    (typeof input.filePath === 'string' && input.filePath.trim() ? input.filePath : undefined);
  const patch = getUnifiedPatch(metadata.filediff?.patch);
  const oldString = typeof input.oldString === 'string' ? input.oldString : undefined;
  const newString = typeof input.newString === 'string' ? input.newString : undefined;
  const hasPreview = patch !== undefined || (oldString !== undefined && newString !== undefined);
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={Pencil}
      title="Edit"
      subtitle={filePath ? <ToolFilePath filePath={filePath} /> : undefined}
      badge={
        <>
          {input.replaceAll === true && (
            <span className="text-muted-foreground shrink-0 text-xs">replace all</span>
          )}
          <ToolDiffStats {...metadata.filediff} />
        </>
      }
      status={state.status}
    >
      {filePath && (
        <div className="text-muted-foreground font-mono text-xs break-all">{filePath}</div>
      )}
      <ToolDiff
        patch={patch}
        original={oldString}
        modified={newString}
        filePath={filePath}
        textLabel="Input snippets (not the full file)"
      />
      {!hasPreview && state.status === 'completed' && state.output.trim() && (
        <ToolCodeBlock content={state.output} label="Output" />
      )}
      <ToolDiagnostics diagnostics={metadata.diagnostics} filePath={filePath} />
      {error && (
        <pre className="bg-background text-destructive max-h-40 overflow-auto rounded-md p-2 text-xs">
          <code>{error}</code>
        </pre>
      )}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs">Editing file…</div>
      )}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs">Waiting to edit…</div>
      )}
    </ToolCardShell>
  );
}
