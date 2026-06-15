'use client';

import { useCallback } from 'react';
import { useClawFileTree, useClawFileTreeLoader, useClawReadFile } from '../hooks/useClawHooks';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import type {
  FileWriteResponse,
  OpenclawFileWriteValidation,
} from '@/lib/kiloclaw/kiloclaw-internal-client';
import { FileEditorShell } from './FileEditorShell';
import { FileEditorPane, type FileSaveError } from './FileEditorPane';
import { validateOpenclawJsonForSave } from './validateOpenclawJson';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function UserFileEditorPane({
  filePath,
  enabled,
  mutations,
  onDirtyChange,
  enableOpenclawValidation,
}: {
  filePath: string;
  enabled: boolean;
  mutations: ClawMutations;
  onDirtyChange: (dirty: boolean) => void;
  enableOpenclawValidation: boolean;
}) {
  const { data, isLoading, error, refetch } = useClawReadFile(filePath, enabled);

  const handleSave = useCallback(
    (
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
    ) => {
      if (!args.etag) return; // Save is disabled until file loads and ETag is set
      mutations.writeFile.mutate({ ...args, etag: args.etag }, callbacks);
    },
    [mutations.writeFile]
  );

  return (
    <FileEditorPane
      filePath={filePath}
      data={data}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onSave={handleSave}
      isSaving={mutations.writeFile.isPending}
      onDirtyChange={onDirtyChange}
      validateBeforeSave={validateOpenclawJsonForSave}
      enableOpenclawValidation={enableOpenclawValidation}
    />
  );
}

export function WorkspaceFileEditor({
  enabled,
  mutations,
  onOpenChange,
  enableOpenclawValidation,
}: {
  enabled: boolean;
  mutations: ClawMutations;
  onOpenChange: (open: boolean) => void;
  enableOpenclawValidation: boolean;
}) {
  const { data: tree, isLoading, error, refetch } = useClawFileTree(enabled);
  const loadChildren = useClawFileTreeLoader(enabled);

  return (
    <FileEditorShell
      tree={tree}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      loadChildren={loadChildren}
      onClose={() => onOpenChange(false)}
      renderPane={(selectedPath, onDirtyChange) => (
        <UserFileEditorPane
          key={selectedPath}
          filePath={selectedPath}
          enabled={enabled}
          mutations={mutations}
          onDirtyChange={onDirtyChange}
          enableOpenclawValidation={enableOpenclawValidation}
        />
      )}
    />
  );
}
