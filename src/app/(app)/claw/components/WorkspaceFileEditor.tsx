'use client';

import { useCallback } from 'react';
import { useClawFileTree, useClawReadFile } from '../hooks/useClawHooks';
import type { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { FileEditorShell } from './FileEditorShell';
import { FileEditorPane, type FileSaveError } from './FileEditorPane';
import { validateOpenclawJsonForSave } from './validateOpenclawJson';

type ClawMutations = ReturnType<typeof useKiloClawMutations>;

function UserFileEditorPane({
  filePath,
  enabled,
  mutations,
  onDirtyChange,
}: {
  filePath: string;
  enabled: boolean;
  mutations: ClawMutations;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { data, isLoading, error, refetch } = useClawReadFile(filePath, enabled);

  const handleSave = useCallback(
    (
      args: { path: string; content: string; etag?: string },
      callbacks: {
        onSuccess: (result: { etag: string }) => void;
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
    />
  );
}

export function WorkspaceFileEditor({
  enabled,
  mutations,
  onOpenChange,
}: {
  enabled: boolean;
  mutations: ClawMutations;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: tree, isLoading, error, refetch } = useClawFileTree(enabled);

  return (
    <FileEditorShell
      tree={tree}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onClose={() => onOpenChange(false)}
      renderPane={(selectedPath, onDirtyChange) => (
        <UserFileEditorPane
          key={selectedPath}
          filePath={selectedPath}
          enabled={enabled}
          mutations={mutations}
          onDirtyChange={onDirtyChange}
        />
      )}
    />
  );
}
