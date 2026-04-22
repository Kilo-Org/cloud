'use client';

import { Check, Copy, Upload } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
} from 'react';

import { usePostHog } from 'posthog-js/react';
import { toast } from 'sonner';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import type {
  KiloClawDashboardStatus,
  OpenclawWorkspaceImportResponse,
} from '@/lib/kiloclaw/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  detectOpenclawImportOs,
  getOpenclawZipCommandForOs,
  OpenclawWorkspaceZipError,
  parseOpenclawWorkspaceZipFile,
  type ParsedOpenclawWorkspaceZip,
} from './openclaw-import-zip';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function hasDraggedFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes('Files');
}

function getZipErrorMessage(error: OpenclawWorkspaceZipError): string {
  switch (error.code) {
    case 'openclaw_import_zip_too_large':
      return 'zip file must be 5 MB or smaller.';
    case 'openclaw_import_too_many_files':
      return 'zip file contains too many files (max 500).';
    case 'openclaw_import_too_large':
      return 'Extracted Markdown content must be 5 MB or smaller.';
    case 'openclaw_import_no_files':
      return 'zip file contains no valid OpenClaw workspace files.';
    case 'openclaw_import_invalid_zip':
      return 'Invalid zip file. Please upload a standard .zip archive.';
    case 'openclaw_import_invalid_path':
    case 'openclaw_import_path_case_conflict':
    case 'openclaw_import_invalid_markdown':
      return error.message;
    default:
      return 'Failed to parse zip file.';
  }
}

function summarizeImportResult(result: OpenclawWorkspaceImportResponse): string {
  const parts: string[] = [];

  if (result.attemptedWriteCount > 0) {
    parts.push(`${result.writtenCount}/${result.attemptedWriteCount} written`);
  }

  if (result.attemptedDeleteCount > 0) {
    parts.push(`${result.deletedCount}/${result.attemptedDeleteCount} deleted`);
  }

  if (result.failedCount > 0) {
    parts.push(`${result.failedCount} failed`);
  }

  return parts.length > 0 ? parts.join(', ') : 'No file changes';
}

export function OpenclawImportCard({
  mutations,
  isRunning,
  instanceStatus,
}: {
  mutations: ClawMutations;
  isRunning: boolean;
  instanceStatus: KiloClawDashboardStatus['status'];
}) {
  const posthog = usePostHog();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isMountedRef = useRef(true);
  const parseAttemptRef = useRef(0);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const [selectedZipName, setSelectedZipName] = useState<string | null>(null);
  const [selectedImport, setSelectedImport] = useState<ParsedOpenclawWorkspaceZip | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  const detectedOs = useMemo(() => {
    if (typeof navigator === 'undefined') return 'linux';
    return detectOpenclawImportOs(navigator.userAgent);
  }, []);

  const zipCommand = useMemo(() => getOpenclawZipCommandForOs(detectedOs), [detectedOs]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
    };
  }, []);

  function resetSelection() {
    setSelectedZipName(null);
    setSelectedImport(null);
    setImportError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function parseZipFile(file: File, source: 'browse' | 'drop') {
    const parseAttempt = parseAttemptRef.current + 1;
    parseAttemptRef.current = parseAttempt;

    if (!isRunning) {
      setImportError('Instance must be running before uploading OpenClaw workspace files.');
      return;
    }

    if (!file.name.toLowerCase().endsWith('.zip')) {
      setSelectedZipName(file.name);
      setSelectedImport(null);
      setImportError('Please select a .zip file.');
      return;
    }

    setIsParsing(true);
    setImportError(null);

    try {
      const parsed = await parseOpenclawWorkspaceZipFile(file);
      if (!isMountedRef.current || parseAttempt !== parseAttemptRef.current) return;

      setSelectedZipName(file.name);
      setSelectedImport(parsed);
      posthog?.capture('claw_openclaw_import_zip_parsed', {
        source,
        zip_name: file.name,
        zip_size_bytes: file.size,
        parsed_file_count: parsed.files.length,
        parsed_utf8_bytes: parsed.totalUtf8Bytes,
        instance_status: instanceStatus,
      });
    } catch (error) {
      if (!isMountedRef.current || parseAttempt !== parseAttemptRef.current) return;

      setSelectedZipName(file.name);
      setSelectedImport(null);
      if (error instanceof OpenclawWorkspaceZipError) {
        setImportError(getZipErrorMessage(error));
        posthog?.capture('claw_openclaw_import_zip_parse_failed', {
          source,
          error_code: error.code,
          instance_status: instanceStatus,
        });
      } else {
        setImportError('Failed to parse zip file.');
      }
    } finally {
      if (isMountedRef.current && parseAttempt === parseAttemptRef.current) {
        setIsParsing(false);
      }
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (!isRunning) {
      setImportError('Instance must be running before uploading OpenClaw workspace files.');
      return;
    }

    const file = event.currentTarget.files?.[0];
    if (!file) return;
    void parseZipFile(file, 'browse');
  }

  function handleCopyCommand() {
    void navigator.clipboard.writeText(zipCommand.command);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    setCopiedCommand(true);
    copyTimeoutRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setCopiedCommand(false);
      copyTimeoutRef.current = null;
    }, 2000);
  }

  function handleCardDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!isRunning) return;
    setIsDraggingCard(true);
  }

  function handleCardDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    if (!isRunning) return;
    setIsDraggingCard(true);
  }

  function handleCardDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setIsDraggingCard(false);
  }

  function handleCardDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setIsDraggingCard(false);

    if (!isRunning) {
      setImportError('Instance must be running before uploading OpenClaw workspace files.');
      return;
    }

    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    void parseZipFile(file, 'drop');
  }

  function handleImport() {
    if (!selectedImport || !isRunning) return;

    posthog?.capture('claw_openclaw_import_confirmed', {
      file_count: selectedImport.files.length,
      utf8_bytes: selectedImport.totalUtf8Bytes,
      instance_status: instanceStatus,
    });

    mutations.importOpenclawWorkspace.mutate(
      { files: selectedImport.files },
      {
        onSuccess: result => {
          setConfirmOpen(false);
          resetSelection();

          const summary = summarizeImportResult(result);
          if (result.ok) {
            toast.success('OpenClaw import complete. Restarting KiloClaw.');
          } else {
            toast.error(`OpenClaw import complete. Restarting KiloClaw. (${summary})`);
          }

          mutations.restartOpenClaw.mutate(undefined, {
            onError: err => {
              const message = err.message || 'Failed to restart KiloClaw';
              toast.error(`OpenClaw imported, but failed to restart KiloClaw: ${message}`);
            },
          });

          posthog?.capture('claw_openclaw_import_completed', {
            ok: result.ok,
            attempted_write_count: result.attemptedWriteCount,
            written_count: result.writtenCount,
            attempted_delete_count: result.attemptedDeleteCount,
            deleted_count: result.deletedCount,
            failed_count: result.failedCount,
            instance_status: instanceStatus,
          });
        },
        onError: err => {
          const message = err.message || 'Import failed';
          setImportError(message);
          toast.error(`Failed to import OpenClaw workspace: ${message}`);
          posthog?.capture('claw_openclaw_import_failed', {
            error_message: message,
            instance_status: instanceStatus,
          });
        },
      }
    );
  }

  const importPending = mutations.importOpenclawWorkspace.isPending;
  const canImport = isRunning && !!selectedImport && !isParsing && !importPending;
  const dropZoneActive = isRunning && isDraggingCard;

  return (
    <div
      onDragEnter={handleCardDragEnter}
      onDragOver={handleCardDragOver}
      onDragLeave={handleCardDragLeave}
      onDrop={handleCardDrop}
      className={`rounded-lg border px-4 py-3 transition-colors ${
        dropZoneActive ? 'border-primary bg-primary/5' : ''
      }`}
    >
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-center gap-3">
          <Upload className="text-muted-foreground h-5 w-5 shrink-0" />
          <div>
            <p className="text-sm font-medium">OpenClaw Import</p>
            <p className="text-muted-foreground text-xs">
              Import USER.md, SOUL.md, IDENTITY.md, MEMORY.md, and memory/* from a zip file.
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
          <div className="flex items-center gap-2">
            <Input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              multiple={false}
              onChange={handleInputChange}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!isRunning || importPending || isParsing}
            >
              Browse...
            </Button>
            {selectedZipName && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={resetSelection}
                disabled={importPending || isParsing}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          Extract your existing OpenClaw workspace with this command. It will save
          openclaw-workspace.zip to your Desktop folder.
        </p>
        <div className="relative">
          <pre className="bg-muted overflow-x-auto rounded-md p-3 pr-10 text-xs">
            <code>{zipCommand.command}</code>
          </pre>
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-1 right-1 h-7 w-7 p-0"
            onClick={handleCopyCommand}
          >
            {copiedCommand ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {isParsing && <p className="text-muted-foreground mt-2 text-xs">Parsing zip file...</p>}

      {importError && (
        <div className="mt-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2">
          <p className="text-xs text-red-300">{importError}</p>
        </div>
      )}

      {selectedImport && (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium">
            Preview ({selectedImport.previewPaths.length} files)
          </p>
          {selectedZipName && <p className="text-muted-foreground text-xs">{selectedZipName}</p>}
          <div className="max-h-40 overflow-auto rounded-md border p-2">
            <ul className="space-y-1 text-xs">
              {selectedImport.previewPaths.map(path => (
                <li key={path} className="font-mono">
                  {path}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              Ready to import {selectedImport.files.length} files.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={!canImport}
              onClick={() => setConfirmOpen(true)}
            >
              Import
            </Button>
          </div>
        </div>
      )}

      {!isRunning && (
        <p className="mt-2 text-xs text-amber-400">
          Instance must be running before uploading or importing OpenClaw workspace files.
        </p>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import OpenClaw Workspace</DialogTitle>
            <DialogDescription>
              This will overwrite matching files in your KiloClaw workspace and restart your
              KiloClaw.
            </DialogDescription>
          </DialogHeader>

          {selectedImport && (
            <div className="space-y-2">
              <p className="text-sm font-medium">Files to import</p>
              <div className="max-h-44 overflow-auto rounded-md border p-2">
                <ul className="space-y-1 text-xs">
                  {selectedImport.previewPaths.map(path => (
                    <li key={path} className="font-mono">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={importPending}
            >
              Cancel
            </Button>
            <Button onClick={handleImport} disabled={!canImport}>
              {importPending ? 'Importing...' : 'Confirm Import & Restart'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
