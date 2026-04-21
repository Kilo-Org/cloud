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
  OPENCLAW_IMPORT_MAX_ZIP_BYTES,
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
      return 'ZIP file must be 5 MB or smaller.';
    case 'openclaw_import_too_many_files':
      return 'ZIP contains too many files (max 500).';
    case 'openclaw_import_too_large':
      return 'Extracted Markdown content must be 5 MB or smaller.';
    case 'openclaw_import_no_files':
      return 'ZIP contains no valid OpenClaw workspace files.';
    case 'openclaw_import_invalid_zip':
      return 'Invalid ZIP file. Please upload a standard .zip archive.';
    case 'openclaw_import_invalid_path':
    case 'openclaw_import_path_case_conflict':
    case 'openclaw_import_invalid_markdown':
      return error.message;
    default:
      return 'Failed to parse ZIP file.';
  }
}

function summarizeImportResult(result: OpenclawWorkspaceImportResponse): string {
  return `${result.writtenCount}/${result.attemptedWriteCount} written, ${result.deletedCount}/${result.attemptedDeleteCount} deleted, ${result.failedCount} failed`;
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
  const dragDepthRef = useRef(0);

  const [isDraggingPage, setIsDraggingPage] = useState(false);
  const [isDraggingCard, setIsDraggingCard] = useState(false);
  const [selectedZipName, setSelectedZipName] = useState<string | null>(null);
  const [selectedImport, setSelectedImport] = useState<ParsedOpenclawWorkspaceZip | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);
  const [lastResult, setLastResult] = useState<OpenclawWorkspaceImportResponse | null>(null);

  const detectedOs = useMemo(() => {
    if (typeof navigator === 'undefined') return 'linux';
    return detectOpenclawImportOs(navigator.userAgent);
  }, []);

  const zipCommand = useMemo(() => getOpenclawZipCommandForOs(detectedOs), [detectedOs]);

  useEffect(() => {
    function handleWindowDragEnter(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      dragDepthRef.current += 1;
      setIsDraggingPage(true);
    }

    function handleWindowDragOver(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      event.preventDefault();
      setIsDraggingPage(true);
    }

    function handleWindowDragLeave(event: DragEvent) {
      if (!hasDraggedFiles(event.dataTransfer)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDraggingPage(false);
      }
    }

    function handleWindowDrop(event: DragEvent) {
      if (hasDraggedFiles(event.dataTransfer)) {
        event.preventDefault();
      }
      dragDepthRef.current = 0;
      setIsDraggingPage(false);
      setIsDraggingCard(false);
    }

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
    };
  }, []);

  function resetSelection() {
    setSelectedZipName(null);
    setSelectedImport(null);
    setImportError(null);
    setLastResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  async function parseZipFile(file: File, source: 'browse' | 'drop') {
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
      setSelectedZipName(file.name);
      setSelectedImport(parsed);
      setLastResult(null);
      posthog?.capture('claw_openclaw_import_zip_parsed', {
        source,
        zip_name: file.name,
        zip_size_bytes: file.size,
        parsed_file_count: parsed.files.length,
        parsed_utf8_bytes: parsed.totalUtf8Bytes,
        instance_status: instanceStatus,
      });
    } catch (error) {
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
        setImportError('Failed to parse ZIP file.');
      }
    } finally {
      setIsParsing(false);
    }
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    void parseZipFile(file, 'browse');
  }

  function handleCopyCommand() {
    void navigator.clipboard.writeText(zipCommand.command);
    setCopiedCommand(true);
    setTimeout(() => setCopiedCommand(false), 2000);
  }

  function handleCardDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
    setIsDraggingCard(true);
  }

  function handleCardDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event.dataTransfer)) return;
    event.preventDefault();
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
          setLastResult(result);
          setConfirmOpen(false);

          const summary = summarizeImportResult(result);
          if (result.ok) {
            toast.success(`OpenClaw import complete: ${summary}`);
          } else {
            toast.error(`OpenClaw import completed with partial failures: ${summary}`);
          }

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
  const dropZoneActive = isDraggingCard || isDraggingPage;

  return (
    <div className="rounded-lg border px-4 py-3">
      <div className="mb-3 flex items-center gap-3">
        <Upload className="text-muted-foreground h-5 w-5 shrink-0" />
        <div>
          <p className="text-sm font-medium">OpenClaw Import</p>
          <p className="text-muted-foreground text-xs">
            Import `USER.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, and `memory/**/*.md` from an
            OpenClaw workspace ZIP.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-xs">
          Generate a ZIP on {zipCommand.title} ({zipCommand.shell}) with:
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

      <div
        onDragEnter={handleCardDragEnter}
        onDragOver={handleCardDragOver}
        onDragLeave={handleCardDragLeave}
        onDrop={handleCardDrop}
        className={`mt-4 rounded-md border-2 border-dashed p-4 transition-colors ${
          dropZoneActive
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50'
        }`}
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">
              {dropZoneActive ? 'Drop your ZIP file here' : 'Upload openclaw-workspace.zip'}
            </p>
            <p className="text-muted-foreground text-xs">
              Max ZIP size {Math.floor(OPENCLAW_IMPORT_MAX_ZIP_BYTES / (1024 * 1024))} MB.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleInputChange}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importPending || isParsing}
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

        {selectedZipName && (
          <p className="text-muted-foreground mt-2 truncate text-xs">Selected: {selectedZipName}</p>
        )}

        {isParsing && <p className="text-muted-foreground mt-2 text-xs">Parsing ZIP...</p>}

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
            Instance must be running before importing OpenClaw workspace files.
          </p>
        )}

        {lastResult && (
          <p className="text-muted-foreground mt-2 text-xs">
            Last import: {summarizeImportResult(lastResult)}
          </p>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import OpenClaw Workspace</DialogTitle>
            <DialogDescription>
              This will overwrite matching files in your KiloClaw workspace. If `MEMORY.md` is in
              the ZIP, existing `workspace/memory/**` files not present in the ZIP will be deleted.
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
              {importPending ? 'Importing...' : 'Confirm Import'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
