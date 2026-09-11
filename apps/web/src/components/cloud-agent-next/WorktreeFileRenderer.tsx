'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getFiletypeFromFileName,
  getHighlighterOptions,
  parsePatchFiles,
  preloadHighlighter,
  type FileDiffMetadata,
  type FileOptions,
  type SupportedLanguages,
} from '@pierre/diffs';
import { File, FileDiff } from '@pierre/diffs/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import { FoldVertical, LockKeyhole, RefreshCw, UnfoldVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toSafeHttpUrl } from '@/lib/safe-http-url';
import type { WorktreeFileViewMode } from './workspace-tabs';
import {
  getWorktreeFileViewMode,
  isWorktreeMarkdownPath,
  worktreeFileOmissionMessages,
} from './worktree-file';
import { getWorktreeDiffExpansion } from './worktree-file-diff';

const rendererCSS = `
:host {
  --diffs-bg: var(--background);
  --diffs-fg: var(--foreground);
  --diffs-font-family: var(--font-mono-loaded, ui-monospace, monospace);
  --diffs-header-font-family: var(--font-sans-loaded, ui-sans-serif, system-ui, sans-serif);
  --diffs-fg-number-override: var(--muted-foreground);
  --diffs-bg-separator-override: var(--muted);
  --diffs-addition-color-override: var(--diff-add-text);
  --diffs-deletion-color-override: var(--diff-delete-text);
}
[data-line-type="change-addition"] { background-color: var(--diff-add-surface); }
[data-line-type="change-deletion"] { background-color: var(--diff-delete-surface); }
[data-expand-index] [data-expand-button]:focus-visible,
[data-expand-index] [data-unmodified-lines]:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -2px;
  border-radius: 4px;
}
@media (max-width: 639px) {
  [data-separator][data-expand-index],
  [data-expand-index] [data-separator-wrapper] { min-height: 44px; }
  [data-expand-index] [data-expand-button],
  [data-expand-index] [data-unmodified-lines] {
    min-width: 44px;
    min-height: 44px;
  }
  [data-expand-index] [data-unmodified-lines] {
    display: inline-flex;
    align-items: center;
  }
}
`;

const fileOptions = {
  theme: 'pierre-dark',
  themeType: 'dark',
  disableFileHeader: true,
  disableLineNumbers: false,
  disableErrorHandling: true,
  overflow: 'wrap',
  lineHoverHighlight: 'disabled',
  unsafeCSS: rendererCSS,
} satisfies FileOptions<undefined>;

export type WorktreeFileHighlighterResult =
  | { status: 'ready'; lang: SupportedLanguages }
  | { status: 'error' };

export function prepareWorktreeFileHighlighter(
  path: string,
  onSettled: (result: WorktreeFileHighlighterResult) => void,
  preload: typeof preloadHighlighter = preloadHighlighter
): () => void {
  let active = true;
  async function prepare() {
    let result: WorktreeFileHighlighterResult;
    try {
      const detected = getFiletypeFromFileName(path);
      const lang = typeof detected === 'string' ? detected : 'text';
      await preload(getHighlighterOptions(lang, fileOptions));
      result = { status: 'ready', lang };
    } catch {
      result = { status: 'error' };
    }
    if (active) onSettled(result);
  }
  void prepare();
  return () => {
    active = false;
  };
}

function WorktreeFileHighlighter({
  path,
  children,
}: {
  path: string;
  children: (lang: SupportedLanguages) => ReactNode;
}) {
  const [result, setResult] = useState<WorktreeFileHighlighterResult | { status: 'loading' }>({
    status: 'loading',
  });
  useEffect(() => prepareWorktreeFileHighlighter(path, setResult), [path]);

  if (result.status !== 'ready') {
    return (
      <p
        role={result.status === 'error' ? 'alert' : 'status'}
        className="text-muted-foreground p-4 text-sm"
      >
        {result.status === 'error'
          ? 'This saved file could not be rendered. Try another view or reload the page.'
          : 'Loading saved file viewer…'}
      </p>
    );
  }
  return children(result.lang);
}

const canonicalGitHeader =
  /^diff --git [^\n]+\n(?:(?:old mode|new mode|new file mode|deleted file mode) 100(?:644|755)\n|index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?\n)*(?:--- [^\n]+\n\+\+\+ [^\n]+\n)?$/;
const emptyGitBlobIds = [
  'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391',
  '473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813',
];

export function parseSavedWorktreePatch(patch: string, path: string): FileDiffMetadata | null {
  try {
    if (!patch.endsWith('\n')) return null;
    const firstHunk = patch.indexOf('\n@@ ');
    const header = firstHunk < 0 ? patch : patch.slice(0, firstHunk + 1);
    if (!canonicalGitHeader.test(header)) return null;
    const patches = parsePatchFiles(patch, undefined, true);
    const parsed = patches[0];
    const file = parsed?.files[0];
    if (patches.length !== 1 || parsed?.patchMetadata || parsed?.files.length !== 1 || !file) {
      return null;
    }
    if (file.hunks.length === 0) {
      if (header.includes('\n--- ')) return null;
      const modeChange =
        file.type === 'change' &&
        file.prevMode &&
        file.mode &&
        file.prevMode !== file.mode &&
        !file.prevObjectId &&
        !file.newObjectId;
      const objectId = file.type === 'new' ? file.newObjectId : file.prevObjectId;
      const missingObjectId = file.type === 'new' ? file.prevObjectId : file.newObjectId;
      const emptyFileChange =
        (file.type === 'new' || file.type === 'deleted') &&
        file.mode &&
        objectId &&
        missingObjectId &&
        /^0+$/.test(missingObjectId) &&
        emptyGitBlobIds.some(emptyId => emptyId.startsWith(objectId));
      if (!modeChange && !emptyFileChange) return null;
    } else if (!/\n--- [^\n]+\n\+\+\+ [^\n]+\n$/.test(header)) {
      return null;
    }
    let parsedLines = header.split('\n').length - 1;
    for (const hunk of file.hunks) {
      if (
        !Number.isSafeInteger(hunk.additionStart + hunk.additionCount) ||
        !Number.isSafeInteger(hunk.deletionStart + hunk.deletionCount) ||
        (hunk.additionCount > 0 && hunk.additionStart === 0) ||
        (hunk.deletionCount > 0 && hunk.deletionStart === 0)
      ) {
        return null;
      }
      const newlineMarkers =
        hunk.hunkContent.at(-1)?.type === 'context'
          ? Number(hunk.noEOFCRAdditions || hunk.noEOFCRDeletions)
          : Number(hunk.noEOFCRAdditions) + Number(hunk.noEOFCRDeletions);
      parsedLines += 1 + hunk.unifiedLineCount + newlineMarkers;
    }
    const lines = patch.split('\n');
    if (
      parsedLines !== lines.length - 1 ||
      lines.some(line => line.startsWith('\\') && line !== '\\ No newline at end of file')
    ) {
      return null;
    }
    return { ...file, name: path, prevName: undefined };
  } catch {
    return null;
  }
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const safeHref = toSafeHttpUrl(href);
  return safeHref ? (
    <a
      href={safeHref}
      target="_blank"
      rel="noopener noreferrer"
      className="text-link hover:text-link-hover focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none"
    >
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

const markdownComponents = {
  a: MarkdownLink,
  img: ({ alt }: { alt?: string }) => <span className="text-muted-foreground">{alt}</span>,
  table: ({ children }: { children?: ReactNode }) => (
    <div className="overflow-x-auto">
      <table>{children}</table>
    </div>
  ),
};

function prepareExpansionControls(node: HTMLElement) {
  const controls = node.shadowRoot?.querySelectorAll<HTMLElement>(
    '[data-expand-index] [data-expand-button], [data-expand-index] [data-unmodified-lines]'
  );
  for (const control of controls ?? []) {
    control.tabIndex = 0;
    control.setAttribute('role', 'button');
    control.setAttribute(
      'aria-label',
      control.hasAttribute('data-expand-all-button')
        ? 'Show all unchanged lines in this region'
        : 'Show more unchanged lines'
    );
    control.onkeydown = event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      control.click();
    };
  }
}

function HighlightedWorktreeDiff({
  diff,
  lang,
  revision,
  expanded,
}: {
  diff: FileDiffMetadata;
  lang: SupportedLanguages;
  revision: number;
  expanded: boolean;
}) {
  const fileDiff = useMemo(() => ({ ...diff, lang }), [diff, lang]);
  return (
    <FileDiff
      key={JSON.stringify([diff.name, revision, expanded])}
      fileDiff={fileDiff}
      options={{
        ...fileOptions,
        diffStyle: 'unified',
        diffIndicators: 'classic',
        hunkSeparators: 'line-info-basic',
        expandUnchanged: expanded,
        onPostRender: prepareExpansionControls,
      }}
      disableWorkerPool
    />
  );
}

export default function WorktreeFileRenderer({
  file,
  mode,
  capturedAt,
  onModeChange,
  isFetching = false,
  onReload,
}: {
  file: WorktreeFileRecord;
  mode: WorktreeFileViewMode;
  capturedAt?: string;
  onModeChange?: (mode: WorktreeFileViewMode) => void;
  isFetching?: boolean;
  onReload?: () => void;
}) {
  const patch = file.diff.status === 'available' ? file.diff.patch : undefined;
  const parsed = useMemo(
    () => (patch !== undefined ? parseSavedWorktreePatch(patch, file.path) : null),
    [patch, file.path]
  );
  const expansion = useMemo(
    () => (parsed ? getWorktreeDiffExpansion(file, parsed) : undefined),
    [file, parsed]
  );
  const canExpand = expansion?.status === 'available';
  const requestedMode = getWorktreeFileViewMode(file, mode);
  const viewMode = requestedMode === 'expanded' && !canExpand ? 'diff' : requestedMode;
  const expanded = viewMode === 'expanded';
  const canPreview = file.content.status === 'available';
  const expandLabel = expanded ? 'Hide unchanged lines' : 'Show all lines';
  const expansionHint =
    expansion?.status === 'unavailable'
      ? `Full content unavailable. ${worktreeFileOmissionMessages[expansion.reason]}`
      : expansion?.status === 'complete'
        ? 'This saved diff has no hidden lines.'
        : file.diff.status === 'omitted'
          ? `Diff omitted. ${worktreeFileOmissionMessages[file.diff.reason]}`
          : 'This saved diff could not be rendered.';
  const previewHint =
    file.content.status === 'unavailable'
      ? `Preview unavailable. ${worktreeFileOmissionMessages[file.content.reason]}`
      : viewMode === 'preview'
        ? 'Show changes'
        : 'Preview Markdown';
  const highlighterKey = JSON.stringify([file.path, file.revision]);

  useEffect(() => {
    if (mode !== viewMode) onModeChange?.(viewMode);
  }, [mode, viewMode, onModeChange]);

  let body: ReactNode;
  if (viewMode === 'preview' && file.content.status === 'available') {
    body =
      file.content.text === '' ? (
        <p role="status" className="text-muted-foreground p-4 text-sm">
          This saved file is empty.
        </p>
      ) : (
        <div className="prose prose-sm prose-invert max-w-none p-4 break-words [&_pre]:whitespace-pre-wrap">
          <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {file.content.text}
          </ReactMarkdown>
        </div>
      );
  } else if (file.diff.status === 'omitted') {
    body = (
      <p role="status" className="text-muted-foreground p-4 text-sm">
        Diff omitted. {worktreeFileOmissionMessages[file.diff.reason]}
      </p>
    );
  } else if (!parsed) {
    body = (
      <p role="alert" className="text-muted-foreground p-4 text-sm">
        This saved diff could not be rendered.
      </p>
    );
  } else if (parsed.hunks.length === 0) {
    const text = expanded && file.content.status === 'available' ? file.content.text : undefined;
    body = (
      <>
        <div className="text-muted-foreground space-y-2 p-4 text-sm">
          <p role="status">Metadata-only change. No text hunks were saved.</p>
          {parsed.type === 'new' && <p>Empty file added.</p>}
          {parsed.type === 'deleted' && <p>Empty file deleted.</p>}
          {parsed.prevMode && parsed.mode && parsed.prevMode !== parsed.mode && (
            <p>
              File mode: <code>{parsed.prevMode}</code> → <code>{parsed.mode}</code>
            </p>
          )}
        </div>
        {text !== undefined && (
          <WorktreeFileHighlighter key={highlighterKey} path={file.path}>
            {lang => (
              <File
                file={{ name: file.path, contents: text, lang }}
                options={fileOptions}
                disableWorkerPool
              />
            )}
          </WorktreeFileHighlighter>
        )}
      </>
    );
  } else {
    body = (
      <WorktreeFileHighlighter key={highlighterKey} path={file.path}>
        {lang => (
          <HighlightedWorktreeDiff
            diff={expansion?.status === 'available' ? expansion.diff : parsed}
            lang={lang}
            revision={file.revision}
            expanded={expanded}
          />
        )}
      </WorktreeFileHighlighter>
    );
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2 sm:h-10">
        <Tooltip>
          <TooltipTrigger asChild>
            <div
              tabIndex={0}
              className="focus-visible:ring-ring flex h-11 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 focus-visible:ring-2 focus-visible:outline-none sm:h-8"
            >
              <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
              <LockKeyhole aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />
              <span className="sr-only">Saved file, read-only</span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-sm space-y-1">
            <p className="font-mono whitespace-pre-wrap break-all">{file.path}</p>
            <p>Saved file · read-only, not live</p>
            {capturedAt && (
              <p>
                <time dateTime={capturedAt}>Saved {new Date(capturedAt).toLocaleString()}</time>
              </p>
            )}
          </TooltipContent>
        </Tooltip>
        {viewMode !== 'diff' &&
          file.content.status === 'available' &&
          file.content.source === 'deleted-original' && (
            <span className="text-muted-foreground shrink-0 text-xs">Deleted · original</span>
          )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={expanded ? 'secondary' : 'ghost'}
              size="icon"
              className="text-muted-foreground h-11 w-11 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent motion-reduce:transition-none sm:h-8 sm:w-8"
              aria-label={expandLabel}
              aria-pressed={expanded}
              aria-disabled={!canExpand}
              onClick={() => {
                if (canExpand) onModeChange?.(expanded ? 'diff' : 'expanded');
              }}
            >
              {expanded ? (
                <FoldVertical aria-hidden="true" className="size-4" />
              ) : (
                <UnfoldVertical aria-hidden="true" className="size-4" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {canExpand ? expandLabel : expansionHint}
          </TooltipContent>
        </Tooltip>
        {isWorktreeMarkdownPath(file.path) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
                size="sm"
                className="text-muted-foreground h-11 shrink-0 px-2 text-xs aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent motion-reduce:transition-none sm:h-8"
                aria-label="Preview Markdown"
                aria-pressed={viewMode === 'preview'}
                aria-disabled={!canPreview}
                onClick={() => {
                  if (canPreview) onModeChange?.(viewMode === 'preview' ? 'diff' : 'preview');
                }}
              >
                Preview
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {previewHint}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-11 w-11 shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 motion-reduce:transition-none sm:h-8 sm:w-8"
              aria-label="Reload saved file"
              aria-disabled={isFetching}
              onClick={() => {
                if (!isFetching) onReload?.();
              }}
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-4 ${isFetching ? 'animate-spin motion-reduce:animate-none' : ''}`}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            Reload saved file without starting the workspace
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto" aria-busy={isFetching}>
        {body}
      </div>
    </>
  );
}
