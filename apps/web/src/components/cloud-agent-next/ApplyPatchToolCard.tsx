import { FileDiff } from 'lucide-react';
import { ToolCardShell } from './ToolCardShell';
import { ToolDiff, ToolDiffStats, ToolFilePath } from './ToolDiff';
import { ToolCodeBlock } from './ToolOutput';
import {
  getUnifiedPatch,
  MAX_TOOL_DIFF_CHARACTERS,
  readApplyPatchFiles,
  sumFileChanges,
} from './toolDiffUtils';
import type { ToolPart } from './types';

type ApplyPatchToolCardProps = {
  toolPart: ToolPart;
};

const changeLabels = {
  add: 'Added',
  update: 'Updated',
  delete: 'Deleted',
  move: 'Moved',
};

export function ApplyPatchToolCard({ toolPart }: ApplyPatchToolCardProps) {
  const state = toolPart.state;
  const files = readApplyPatchFiles(state.status === 'pending' ? undefined : state.metadata);
  const single = files.length === 1 ? files[0] : undefined;
  const patchText = typeof state.input.patchText === 'string' ? state.input.patchText : undefined;
  const error = state.status === 'error' ? state.error : undefined;

  return (
    <ToolCardShell
      icon={FileDiff}
      title="Apply patch"
      subtitle={
        single ? (
          <ToolFilePath filePath={single.relativePath ?? single.movePath ?? single.filePath} />
        ) : files.length > 0 ? (
          `${files.length} files`
        ) : undefined
      }
      badge={<ToolDiffStats {...sumFileChanges(files)} />}
      status={state.status}
    >
      {files.map((file, index) => {
        const filePath = file.relativePath ?? file.movePath ?? file.filePath;
        return (
          <section key={`${index}:${filePath}`} className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                {file.type ? changeLabels[file.type] : 'Changed'}
              </span>
              <code className="min-w-0 break-all">{filePath}</code>
              <ToolDiffStats additions={file.additions} deletions={file.deletions} />
            </div>
            {file.type === 'move' && (
              <div className="text-muted-foreground space-y-1 text-xs">
                <div>
                  From: <code className="break-all">{file.filePath ?? 'Unknown source'}</code>
                </div>
                <div>
                  To:{' '}
                  <code className="break-all">
                    {file.movePath ?? file.relativePath ?? 'Unknown destination'}
                  </code>
                </div>
              </div>
            )}
            <ToolDiff
              patch={getUnifiedPatch(file.patch) ?? getUnifiedPatch(file.diff)}
              filePath={filePath}
            />
          </section>
        );
      })}
      {files.length === 0 && (
        <div className="space-y-2">
          <div className="text-muted-foreground text-xs">
            File summaries and diff preview unavailable: no usable file metadata was provided.
          </div>
          {patchText !== undefined && patchText.length > 0 && (
            <div className="space-y-1">
              <div className="text-muted-foreground text-xs">Patch input (not an applied diff)</div>
              <pre
                className="bg-background focus-visible:ring-ring max-h-60 overflow-auto rounded-md p-2 text-xs focus-visible:ring-2 focus-visible:outline-none"
                tabIndex={0}
                role="region"
                aria-label="Patch input"
              >
                <code>{patchText.slice(0, MAX_TOOL_DIFF_CHARACTERS)}</code>
              </pre>
              {patchText.length > MAX_TOOL_DIFF_CHARACTERS && (
                <div className="text-muted-foreground text-xs">Patch input truncated.</div>
              )}
            </div>
          )}
          {state.status === 'completed' && state.output.trim() && (
            <ToolCodeBlock content={state.output} label="Output" />
          )}
        </div>
      )}
      {error && (
        <pre className="bg-background text-destructive max-h-40 overflow-auto rounded-md p-2 text-xs">
          <code>{error}</code>
        </pre>
      )}
      {state.status === 'running' && (
        <div className="text-muted-foreground text-xs">Applying patch…</div>
      )}
      {state.status === 'pending' && (
        <div className="text-muted-foreground text-xs">Waiting to apply patch…</div>
      )}
    </ToolCardShell>
  );
}
