'use client';

import { Suspense, lazy, useState, useCallback, useEffect, useRef } from 'react';
import type { DiffEditorProps, EditorProps } from '@monaco-editor/react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type {
  FileWriteResponse,
  OpenclawFileWriteValidation,
} from '@/lib/kiloclaw/kiloclaw-internal-client';

const Editor = lazy<React.ComponentType<EditorProps>>(() => import('@monaco-editor/react'));
const DiffEditor = lazy<React.ComponentType<DiffEditorProps>>(() =>
  import('@monaco-editor/react').then(mod => ({ default: mod.DiffEditor }))
);

export const EDITOR_OPTIONS = {
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 13,
  folding: true,
  wordWrap: 'on' as const,
  automaticLayout: true,
  tabSize: 2,
  padding: { top: 8, bottom: 8 },
  scrollbar: {
    vertical: 'auto' as const,
    horizontal: 'hidden' as const,
    verticalScrollbarSize: 8,
  },
};

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.json': 'json',
  '.json5': 'json',
  '.md': 'markdown',
  '.txt': 'plaintext',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
};

function EditorLoading() {
  return (
    <div className="bg-muted flex min-h-[400px] items-center justify-center rounded-md border">
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading editor...
      </div>
    </div>
  );
}

export interface FileSaveError {
  message: string;
  data?: { code?: string; upstreamCode?: string } | null;
}

export interface FileEditorPaneProps {
  filePath: string;
  data: { content: string; etag: string } | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => void;
  onSave: (
    args: {
      path: string;
      content: string;
      etag?: string;
      openclawValidation?: OpenclawFileWriteValidation;
    },
    callbacks: {
      onSuccess: (result: FileWriteResponse) => void;
      onError: (err: FileSaveError) => void;
    }
  ) => void;
  isSaving: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  validateBeforeSave?: (filePath: string, content: string) => boolean;
  enableOpenclawValidation?: boolean;
}

export function FileEditorPane({
  filePath,
  data,
  isLoading,
  error,
  refetch,
  onSave,
  isSaving,
  onDirtyChange,
  validateBeforeSave,
  enableOpenclawValidation = false,
}: FileEditorPaneProps) {
  const [showDiff, setShowDiff] = useState(false);
  const [pendingValidationWarning, setPendingValidationWarning] = useState<
    | (Extract<FileWriteResponse, { outcome: 'openclaw-validation-warning' }> & { content: string })
    | null
  >(null);

  // savedContentRef holds the last successfully saved content, used as fallback
  // until the query refetches to avoid flashing stale content after save.
  const savedContentRef = useRef<string | null>(null);
  const serverContent = savedContentRef.current ?? data?.content ?? '';
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const etagRef = useRef<string | undefined>(undefined);

  // Reset editor state when filePath changes (without an effect + dependency the linter flags).
  const prevFilePathRef = useRef(filePath);
  if (prevFilePathRef.current !== filePath) {
    prevFilePathRef.current = filePath;
    setEditedContent(null);
    setShowDiff(false);
    setPendingValidationWarning(null);
    etagRef.current = undefined;
    savedContentRef.current = null;
  }

  useEffect(() => {
    if (data?.etag) {
      etagRef.current = data.etag;
      // Clear the optimistic saved content once the refetch lands with a fresh ETag
      savedContentRef.current = null;
    }
  }, [data?.etag]);

  const currentValue = editedContent ?? serverContent;
  const hasChanges = editedContent !== null && editedContent !== serverContent;

  useEffect(() => {
    onDirtyChange?.(hasChanges);
  }, [hasChanges, onDirtyChange]);

  const ext = filePath.includes('.') ? `.${filePath.split('.').pop()}` : '';
  const language = EXT_TO_LANGUAGE[ext] ?? 'plaintext';

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const next = value ?? '';
      if (next === serverContent) {
        setEditedContent(null);
      } else {
        setEditedContent(next);
      }
    },
    [serverContent]
  );

  const submitSave = useCallback(
    (content: string, openclawValidation?: OpenclawFileWriteValidation) => {
      onSave(
        { path: filePath, content, etag: etagRef.current, openclawValidation },
        {
          onSuccess: result => {
            if ('outcome' in result) {
              setPendingValidationWarning({ ...result, content });
              return;
            }
            etagRef.current = result.etag;
            savedContentRef.current = content;
            setEditedContent(null);
            setPendingValidationWarning(null);
            toast.success(`Saved ${filePath}`);
          },
          onError: err => {
            if (err.data?.code === 'CONFLICT' && err.data?.upstreamCode === 'file_etag_conflict') {
              setPendingValidationWarning(null);
              refetch();
              setShowDiff(true);
              toast.error(
                'File was modified externally — your edits are preserved, review the diff'
              );
            } else {
              toast.error(err.message);
            }
          },
        }
      );
    },
    [filePath, onSave, refetch]
  );

  if (isLoading) {
    return <EditorLoading />;
  }

  if (error) {
    return (
      <Alert className="my-2">
        <AlertDescription>{error?.message ?? 'Failed to load file'}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="bg-muted/30 flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground font-mono">{filePath}</span>
          {hasChanges && (
            <span className="text-muted-foreground flex items-center gap-1">
              <span className="text-orange-400">●</span> modified
            </span>
          )}
        </div>
        <Button
          variant={showDiff ? 'secondary' : 'ghost'}
          size="sm"
          className="h-6 text-xs"
          disabled={!hasChanges}
          onClick={() => setShowDiff(prev => !prev)}
        >
          {showDiff ? 'Hide diff' : 'Show diff'}
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        <Suspense fallback={<EditorLoading />}>
          {showDiff && hasChanges ? (
            <DiffEditor
              height="100%"
              language={language}
              original={serverContent}
              modified={currentValue}
              theme="vs-dark"
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              options={{
                ...EDITOR_OPTIONS,
                readOnly: true,
                lineNumbers: 'off',
                renderSideBySide: false,
                hideUnchangedRegions: {
                  enabled: true,
                  contextLineCount: 2,
                  minimumLineCount: 3,
                  revealLineCount: 10,
                },
                diffAlgorithm: 'advanced',
              }}
            />
          ) : (
            <Editor
              height="100%"
              language={language}
              value={currentValue}
              onChange={handleEditorChange}
              theme="vs-dark"
              options={{ ...EDITOR_OPTIONS, readOnly: isSaving }}
              keepCurrentModel
            />
          )}
        </Suspense>
      </div>

      <div className="flex items-center justify-between border-t px-3 py-1.5">
        <span className="text-muted-foreground text-xs capitalize">{language}</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={!hasChanges || isSaving}
            onClick={() => setEditedContent(null)}
          >
            Discard
          </Button>
          <Button
            variant="default"
            size="sm"
            className="h-7 text-xs"
            disabled={!hasChanges || isSaving}
            onClick={() => {
              if (validateBeforeSave && !validateBeforeSave(filePath, currentValue)) {
                return;
              }
              submitSave(
                currentValue,
                enableOpenclawValidation && filePath === 'openclaw.json'
                  ? 'warn-before-write'
                  : undefined
              );
            }}
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                Saving...
              </>
            ) : (
              'Save'
            )}
          </Button>
        </div>
      </div>

      <AlertDialog
        open={pendingValidationWarning !== null}
        onOpenChange={open => {
          if (!open && !isSaving) setPendingValidationWarning(null);
        }}
      >
        <AlertDialogContent className="sm:max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingValidationWarning?.reason === 'invalid'
                ? 'OpenClaw configuration is invalid'
                : 'Configuration validation could not run'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingValidationWarning?.reason === 'invalid'
                ? 'OpenClaw may reject this file or restore the previous configuration during reload or startup.'
                : 'Save without validation only if you understand that OpenClaw may reject or restore this file.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingValidationWarning && (
            <div className="bg-muted max-h-48 overflow-y-auto rounded-md border p-3 text-xs">
              <ul className="space-y-2">
                {pendingValidationWarning.issues.map((issue, index) => (
                  <li key={`${issue.path}:${index}`} className="space-y-0.5">
                    {issue.path && <div className="font-mono text-destructive">{issue.path}</div>}
                    <div className="text-muted-foreground">{issue.message}</div>
                    {issue.allowedValues && issue.allowedValues.length > 0 && (
                      <div className="text-muted-foreground font-mono">
                        Allowed values: {issue.allowedValues.join(', ')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isSaving || !pendingValidationWarning}
              onClick={() => {
                if (pendingValidationWarning) {
                  submitSave(pendingValidationWarning.content, 'allow-invalid');
                }
              }}
            >
              {isSaving ? 'Saving...' : 'Save anyway'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
