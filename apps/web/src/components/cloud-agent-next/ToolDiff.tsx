'use client';

import dynamic from 'next/dynamic';
import { useLayoutEffect, useRef } from 'react';
import type { DiffEditorProps, DiffOnMount } from '@monaco-editor/react';
import { cn } from '@/lib/utils';
import { getFilename } from './toolCardUtils';
import {
  countLines,
  getUnifiedPatch,
  MAX_TOOL_DIFF_CHARACTERS,
  MAX_TOOL_DIFF_LINES,
  readToolDiagnostics,
  type ToolFileChanges,
} from './toolDiffUtils';

const DiffEditor = dynamic(() => import('@monaco-editor/react').then(module => module.DiffEditor), {
  ssr: false,
  loading: () => <div className="text-muted-foreground p-2 text-xs">Loading diff…</div>,
});

function MountedDiffEditor(props: DiffEditorProps) {
  const editorRef = useRef<Parameters<DiffOnMount>[0] | null>(null);

  useLayoutEffect(() => {
    return () => {
      const editor = editorRef.current;
      if (!editor) return;
      editorRef.current = null;
      const models = editor.getModel();
      editor.setModel(null);
      models?.original.dispose();
      models?.modified.dispose();
    };
  }, []);

  return (
    <DiffEditor
      {...props}
      onMount={editor => {
        editorRef.current = editor;
      }}
    />
  );
}

type ToolDiffProps = {
  patch?: string;
  original?: string;
  modified?: string;
  filePath?: string;
  textLabel?: string;
};

export function ToolDiff({ patch, original, modified, filePath, textLabel }: ToolDiffProps) {
  const unifiedPatch = getUnifiedPatch(patch);
  const tooLargeMessage = 'Diff preview unavailable: this change is too large to display inline.';

  if (unifiedPatch !== undefined) {
    if (unifiedPatch.length > MAX_TOOL_DIFF_CHARACTERS) {
      return <div className="text-muted-foreground text-xs">{tooLargeMessage}</div>;
    }
    const lines = unifiedPatch.split(/\r?\n/, MAX_TOOL_DIFF_LINES + 1);
    if (lines.length > MAX_TOOL_DIFF_LINES) {
      return <div className="text-muted-foreground text-xs">{tooLargeMessage}</div>;
    }
    let inHunk = false;
    return (
      <pre
        className="bg-background focus-visible:ring-ring max-h-80 min-w-0 overflow-auto rounded-md py-2 text-xs focus-visible:ring-2 focus-visible:outline-none"
        tabIndex={0}
        role="region"
        aria-label={filePath ? `Unified patch for ${filePath}` : 'Unified patch'}
      >
        <code className="block w-max min-w-full">
          {lines.map((line, index) => {
            const isHunkHeader = line.startsWith('@@');
            const isFileBoundary = line.startsWith('diff ') || line.startsWith('Index:');
            if (isFileBoundary) inHunk = false;
            else if (isHunkHeader) inHunk = true;
            const isHeader =
              !inHunk &&
              (line.startsWith('--- ') ||
                line.startsWith('+++ ') ||
                isFileBoundary ||
                line.startsWith('==='));
            return (
              <span
                key={index}
                className={cn(
                  'block min-w-max px-2',
                  isHeader && 'text-muted-foreground',
                  isHunkHeader && 'bg-muted text-muted-foreground',
                  inHunk && line.startsWith('+') && 'bg-diff-add-surface text-diff-add-text',
                  inHunk && line.startsWith('-') && 'bg-diff-delete-surface text-diff-delete-text'
                )}
              >
                {line || ' '}
              </span>
            );
          })}
        </code>
      </pre>
    );
  }

  if (original === undefined || modified === undefined) {
    return (
      <div className="text-muted-foreground text-xs">
        Diff preview unavailable: no usable patch or text was provided.
      </div>
    );
  }
  if (original.length + modified.length > MAX_TOOL_DIFF_CHARACTERS) {
    return <div className="text-muted-foreground text-xs">{tooLargeMessage}</div>;
  }
  const lineCount = countLines(original) + countLines(modified);
  if (lineCount > MAX_TOOL_DIFF_LINES) {
    return <div className="text-muted-foreground text-xs">{tooLargeMessage}</div>;
  }

  return (
    <div className="min-w-0 space-y-1">
      {textLabel && <div className="text-muted-foreground text-xs">{textLabel}</div>}
      {original === '' && modified === '' && (
        <div className="text-muted-foreground text-xs">Empty content.</div>
      )}
      <div
        className="bg-background min-w-0 overflow-hidden rounded-md"
        role="region"
        aria-label={filePath ? `Inline diff for ${filePath}` : 'Inline diff'}
      >
        <MountedDiffEditor
          height={Math.min(320, Math.max(96, lineCount * 18 + 16))}
          original={original}
          modified={modified}
          language="plaintext"
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: false,
            renderMarginRevertIcon: false,
            renderGutterMenu: false,
            minimap: { enabled: false },
            lineNumbers: 'off',
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineHeight: 18,
            folding: false,
            wordWrap: 'on',
            automaticLayout: true,
            padding: { top: 8, bottom: 8 },
            contextmenu: false,
            links: false,
            renderOverviewRuler: false,
            hideUnchangedRegions: {
              enabled: true,
              contextLineCount: 2,
              minimumLineCount: 3,
              revealLineCount: 10,
            },
            ignoreTrimWhitespace: false,
            diffAlgorithm: 'advanced',
            maxComputationTime: 1000,
          }}
        />
      </div>
    </div>
  );
}

export function ToolDiffStats({ additions, deletions }: ToolFileChanges) {
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className="inline-flex shrink-0 gap-1.5 font-mono text-xs tabular-nums">
      {additions !== undefined && (
        <span className="text-diff-add-text" aria-label={`${additions} additions`}>
          +{additions}
        </span>
      )}
      {deletions !== undefined && (
        <span className="text-diff-delete-text" aria-label={`${deletions} deletions`}>
          -{deletions}
        </span>
      )}
    </span>
  );
}

export function ToolFilePath({ filePath }: { filePath: string | undefined }) {
  if (!filePath) return null;
  const normalized = filePath.replaceAll('\\', '/');
  const filename = getFilename(normalized);
  const directory = normalized.slice(0, -filename.length);
  return (
    <span className="inline-flex max-w-full min-w-0 gap-2" title={filePath}>
      <span className="text-foreground max-w-[65%] min-w-0 shrink-0 truncate">{filename}</span>
      {directory && <span className="text-muted-foreground min-w-0 truncate">{directory}</span>}
    </span>
  );
}

export function ToolDiagnostics({
  diagnostics,
  filePath,
}: {
  diagnostics: unknown;
  filePath: string | undefined;
}) {
  const excerpts = readToolDiagnostics(diagnostics, filePath);
  if (excerpts.length === 0) return null;
  return (
    <ul className="space-y-1 text-xs" aria-label="File diagnostics">
      {excerpts.map((diagnostic, index) => (
        <li key={index} className="text-muted-foreground break-words">
          <span className="text-destructive">Error</span>{' '}
          {diagnostic.range && (
            <span className="font-mono">
              [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]{' '}
            </span>
          )}
          {diagnostic.message}
        </li>
      ))}
    </ul>
  );
}
