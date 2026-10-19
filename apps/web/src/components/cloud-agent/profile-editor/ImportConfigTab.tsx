/** Import tab for the profile editor: upload a local config ZIP, pick definitions, import them. */
'use client';

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { FileArchive, Loader2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';
import {
  IMPORT_CATEGORIES,
  isImportArchiveWithinLimit,
  MAX_IMPORT_ZIP_BYTES,
  type ImportCategory,
  type ImportPreview,
} from '@kilocode/cloud-agent-profile/import';
import { useProfileMutations } from '@/hooks/useCloudAgentProfiles';
import { createSelectionGuard, decodeArchiveLocally, encodeArchiveBody } from './config-import';
import {
  countSelected,
  getChangedIds,
  getSectionCheckState,
  getSelectableIds,
  selectAll,
  setItemSelected,
  setSectionSelected,
  toImportSelection,
  type ImportSelectionState,
} from './config-import-selection';
import { ImportConfigCommands } from './ImportConfigCommands';
import {
  ImportIssues,
  ImportSection,
  type CategoryDiffData,
  type ImportIssueView,
} from './ImportConfigDiff';

type Props = {
  profileId: string;
  organizationId: string | undefined;
  readOnly?: boolean;
};

type Status = 'idle' | 'reading' | 'previewing' | 'applying';

type ServerPreview = Record<ImportCategory, CategoryDiffData<unknown>> & {
  issues: ImportIssueView[];
};

const SECTION_TITLES: Record<ImportCategory, string> = {
  agents: 'Agents',
  commands: 'Slash commands',
  skills: 'Skills',
  instructions: 'Instructions',
};

const NO_SELECTION: ImportSelectionState = {
  agents: new Set(),
  commands: new Set(),
  skills: new Set(),
  instructions: new Set(),
};

export function ImportConfigTab({ profileId, organizationId, readOnly = false }: Props) {
  const { previewConfigImport, applyConfigImport } = useProfileMutations({ organizationId });
  const confirm = useConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef(createSelectionGuard());

  const [fileName, setFileName] = useState<string | null>(null);
  const [archiveBody, setArchiveBody] = useState<string | null>(null);
  const [localPreview, setLocalPreview] = useState<ImportPreview | null>(null);
  const [preview, setPreview] = useState<ServerPreview | null>(null);
  const [selection, setSelection] = useState<ImportSelectionState>(NO_SELECTION);
  const [status, setStatus] = useState<Status>('idle');
  const [dragDepth, setDragDepth] = useState(0);

  const isBusy = status !== 'idle';
  const isDragging = dragDepth > 0;

  const selectableIds = useMemo(() => (preview ? getSelectableIds(preview) : null), [preview]);
  const selectedCount = selectableIds ? countSelected(selection, selectableIds) : 0;
  const hasImportableItems = selectableIds
    ? IMPORT_CATEGORIES.some(category => selectableIds[category].length > 0)
    : false;

  const showPreview = (result: ServerPreview) => {
    setPreview(result);
    setSelection(selectAll(getSelectableIds(result)));
  };

  const reset = () => {
    selectionRef.current.invalidate();
    setFileName(null);
    setArchiveBody(null);
    setLocalPreview(null);
    setPreview(null);
    setSelection(NO_SELECTION);
    setStatus('idle');
    if (inputRef.current) inputRef.current.value = '';
  };

  const pick = () => {
    if (!inputRef.current) return;
    inputRef.current.value = '';
    inputRef.current.click();
  };

  const selectArchive = async (file: File) => {
    if (isBusy) return;
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast.error('Choose a .zip archive of a local Kilo config directory');
      return;
    }

    if (file.size > MAX_IMPORT_ZIP_BYTES) {
      toast.error(`Archive exceeds ${MAX_IMPORT_ZIP_BYTES} bytes`);
      return;
    }

    const token = selectionRef.current.begin();
    setStatus('reading');
    setFileName(file.name);
    setArchiveBody(null);
    setLocalPreview(null);
    setPreview(null);

    let archive: Uint8Array;
    try {
      archive = new Uint8Array(await file.arrayBuffer());
    } catch {
      if (selectionRef.current.isCurrent(token)) {
        toast.error('Failed to read the archive');
        setStatus('idle');
      }
      return;
    }
    if (!selectionRef.current.isCurrent(token)) return;

    if (!isImportArchiveWithinLimit(archive)) {
      toast.error(`Archive exceeds ${MAX_IMPORT_ZIP_BYTES} bytes`);
      setStatus('idle');
      return;
    }

    const body = encodeArchiveBody(archive);
    setLocalPreview(decodeArchiveLocally(archive));
    setArchiveBody(body);
    setStatus('previewing');

    try {
      const result = await previewConfigImport.mutateAsync({
        profileId,
        organizationId,
        archive: body,
      });
      if (!selectionRef.current.isCurrent(token)) return;
      showPreview(result);
    } catch (error) {
      if (!selectionRef.current.isCurrent(token)) return;
      console.error('Failed to preview config import:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to preview import');
    } finally {
      if (selectionRef.current.isCurrent(token)) setStatus('idle');
    }
  };

  const handleApply = async () => {
    if (!archiveBody || !preview || selectedCount === 0) return;

    const overwriteCount = countSelected(selection, getChangedIds(preview));
    if (overwriteCount > 0) {
      const confirmed = await confirm({
        title: `Overwrite ${overwriteCount === 1 ? '1 definition' : `${overwriteCount} definitions`}?`,
        description:
          'Selected definitions marked "changed" already exist on this profile. Importing them replaces their cloud versions. Other definitions are not changed.',
        confirmLabel: 'Import',
        destructive: true,
      });
      if (!confirmed) return;
    }

    setStatus('applying');
    try {
      await applyConfigImport.mutateAsync({
        profileId,
        organizationId,
        archive: archiveBody,
        selection: toImportSelection(selection),
      });
      toast.success(
        selectedCount === 1 ? 'Imported 1 definition' : `Imported ${selectedCount} definitions`
      );
      reset();
    } catch (error) {
      console.error('Failed to apply config import:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to apply import');
    } finally {
      setStatus('idle');
    }
  };

  const dragHasFile = (event: DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer?.items ?? []).some(item => item.kind === 'file');

  const issues = preview?.issues ?? localPreview?.issues ?? [];

  return (
    <div
      className="space-y-3 p-4"
      onDragEnter={event => {
        if (readOnly || !dragHasFile(event)) return;
        event.preventDefault();
        setDragDepth(depth => depth + 1);
      }}
      onDragLeave={() => setDragDepth(depth => Math.max(0, depth - 1))}
      onDragOver={event => {
        if (readOnly || !dragHasFile(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={event => {
        if (readOnly) return;
        event.preventDefault();
        setDragDepth(0);
        const file = Array.from(event.dataTransfer.files).find(candidate =>
          candidate.name.toLowerCase().endsWith('.zip')
        );
        if (!file) {
          toast.error('Drop a .zip archive of a local Kilo config directory');
          return;
        }
        void selectArchive(file);
      }}
    >
      {!readOnly && (
        <>
          <div
            className={cn(
              'flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center transition-colors',
              isDragging && 'border-primary bg-primary/5'
            )}
          >
            <Upload className="text-muted-foreground h-5 w-5" />
            <p className="text-sm font-medium">Drop a ZIP of your Kilo config here</p>
            <Button variant="outline" size="sm" onClick={pick} disabled={isBusy}>
              Choose ZIP
            </Button>
            <p className="text-muted-foreground text-xs">
              Up to {(MAX_IMPORT_ZIP_BYTES / (1024 * 1024)).toFixed(1)} MB. Nothing is saved until
              you review and apply the import.
            </p>
          </div>

          {!fileName && <ImportConfigCommands />}

          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            className="hidden"
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void selectArchive(file);
            }}
          />
        </>
      )}

      {fileName && (
        <div className="flex items-center justify-between gap-2 rounded-lg border p-3">
          <div className="flex min-w-0 items-center gap-2">
            <FileArchive className="text-muted-foreground h-4 w-4 shrink-0" />
            <span className="truncate font-mono text-sm">{fileName}</span>
            {(status === 'reading' || status === 'previewing') && (
              <Loader2 className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" size="sm" onClick={pick} disabled={isBusy}>
              Choose another
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={reset}
              disabled={isBusy}
              aria-label="Remove archive"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {localPreview && !preview && status === 'previewing' && (
        <p className="text-muted-foreground text-xs">
          Decoded {localPreview.config.agents.length} agents, {localPreview.config.commands.length}{' '}
          commands, {localPreview.config.skills.length} skills,{' '}
          {localPreview.config.instructions.length} instructions. Comparing with the profile…
        </p>
      )}

      {preview && selectableIds && (
        <div className="space-y-2">
          {hasImportableItems ? (
            IMPORT_CATEGORIES.filter(category => selectableIds[category].length > 0).map(
              category => (
                <ImportSection
                  key={category}
                  title={SECTION_TITLES[category]}
                  preview={preview[category]}
                  sectionState={getSectionCheckState(selection, selectableIds, category)}
                  isSelected={id => selection[category].has(id)}
                  onSectionChange={selected =>
                    setSelection(current =>
                      setSectionSelected(current, selectableIds, category, selected)
                    )
                  }
                  onItemChange={(id, selected) =>
                    setSelection(current => setItemSelected(current, category, id, selected))
                  }
                />
              )
            )
          ) : (
            <p className="text-muted-foreground rounded-lg border p-3 text-sm">
              {localPreview && IMPORT_CATEGORIES.every(c => localPreview.config[c].length === 0)
                ? 'This archive has no agents, slash commands, skills, or instructions to import.'
                : 'Nothing to import. This profile already matches the archive.'}
            </p>
          )}
        </div>
      )}

      {issues.length > 0 && (
        <ImportIssues
          key={preview ? 'server' : 'local'}
          issues={issues}
          defaultOpen={preview !== null && !hasImportableItems}
        />
      )}

      {preview && hasImportableItems && (
        <div className="flex items-center justify-end gap-3">
          <p className="text-muted-foreground text-xs">
            Variables, setup commands, MCP servers, and definitions you do not select are not
            changed.
          </p>
          <Button
            onClick={() => void handleApply()}
            disabled={readOnly || isBusy || selectedCount === 0 || !archiveBody}
          >
            {status === 'applying' && <Loader2 className="h-4 w-4 animate-spin" />}
            Import {selectedCount === 1 ? '1 definition' : `${selectedCount} definitions`}
          </Button>
        </div>
      )}
    </div>
  );
}
