'use client';

import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { FileEditorShell } from '@/app/(app)/claw/components/FileEditorShell';
import { FileEditorPane, type FileSaveError } from '@/app/(app)/claw/components/FileEditorPane';
import { validateOpenclawJsonForSave } from '@/app/(app)/claw/components/validateOpenclawJson';
import type {
  FileWriteResponse,
  OpenclawFileWriteValidation,
} from '@/lib/kiloclaw/kiloclaw-internal-client';

function AdminFileEditorPaneInner({
  userId,
  instanceId,
  filePath,
  writeFileMutation,
  onDirtyChange,
  enableOpenclawValidation,
}: {
  userId: string;
  instanceId: string;
  filePath: string;
  writeFileMutation: ReturnType<typeof useMutation<FileWriteResponse, any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  onDirtyChange: (dirty: boolean) => void;
  enableOpenclawValidation: boolean;
}) {
  const trpc = useTRPC();
  const { data, isLoading, error, refetch } = useQuery(
    trpc.admin.kiloclawInstances.readFile.queryOptions(
      { userId, instanceId, path: filePath },
      { refetchOnWindowFocus: false, refetchOnMount: 'always' }
    )
  );

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
      writeFileMutation.mutate(
        {
          userId,
          instanceId,
          path: args.path,
          content: args.content,
          etag: args.etag,
          openclawValidation: args.openclawValidation,
        },
        callbacks
      );
    },
    [writeFileMutation, userId, instanceId]
  );

  const validateBeforeSave = useCallback(validateOpenclawJsonForSave, []);

  return (
    <FileEditorPane
      filePath={filePath}
      data={data}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      onSave={handleSave}
      isSaving={writeFileMutation.isPending}
      onDirtyChange={onDirtyChange}
      validateBeforeSave={validateBeforeSave}
      enableOpenclawValidation={enableOpenclawValidation}
    />
  );
}

export function AdminFileEditor({
  userId,
  instanceId,
  enableOpenclawValidation,
}: {
  userId: string;
  instanceId: string;
  enableOpenclawValidation: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [enabled, setEnabled] = useState(false);

  const {
    data: tree,
    isLoading,
    error,
    refetch,
  } = useQuery(
    trpc.admin.kiloclawInstances.fileTree.queryOptions(
      { userId, instanceId },
      { refetchOnWindowFocus: false, enabled }
    )
  );

  const writeFileMutation = useMutation(
    trpc.admin.kiloclawInstances.writeFile.mutationOptions({
      onSuccess: async result => {
        if ('outcome' in result) return;
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.fileTree.queryKey({ userId, instanceId }),
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.admin.kiloclawInstances.readFile.queryKey({ userId, instanceId }),
        });
      },
    })
  );

  if (!enabled) {
    return (
      <Button variant="outline" size="sm" onClick={() => setEnabled(true)}>
        <FolderOpen className="mr-2 h-4 w-4" />
        Load File Tree
      </Button>
    );
  }

  return (
    <FileEditorShell
      tree={tree}
      isLoading={isLoading}
      error={error}
      refetch={refetch}
      height="600px"
      renderPane={(selectedPath, onDirtyChange) => (
        <AdminFileEditorPaneInner
          key={selectedPath}
          userId={userId}
          instanceId={instanceId}
          filePath={selectedPath}
          writeFileMutation={writeFileMutation}
          onDirtyChange={onDirtyChange}
          enableOpenclawValidation={enableOpenclawValidation}
        />
      )}
    />
  );
}
