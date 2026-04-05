'use client';

import { useState, useCallback, useRef, type ReactNode } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
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
import { useResizableSidebar } from '@/hooks/useResizableSidebar';
import type { FileNode } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { FileTree } from './FileTree';

export function FileEditorShell({
  tree,
  isLoading,
  error,
  refetch,
  renderPane,
  onClose,
  height,
}: {
  tree: FileNode[] | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => void;
  renderPane: (selectedPath: string, onDirtyChange: (dirty: boolean) => void) => ReactNode;
  onClose?: () => void;
  height?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { type: 'switch'; path: string } | { type: 'close' } | null
  >(null);
  const hasUnsavedChangesRef = useRef(false);
  const { width: sidebarWidth, startDrag } = useResizableSidebar();

  const handleDirtyChange = useCallback((dirty: boolean) => {
    hasUnsavedChangesRef.current = dirty;
  }, []);

  const handleSelect = useCallback(
    (path: string) => {
      if (path === selectedPath) return;
      if (hasUnsavedChangesRef.current) {
        setPendingAction({ type: 'switch', path });
        return;
      }
      setSelectedPath(path);
    },
    [selectedPath]
  );

  const handleClose = useCallback(() => {
    if (!onClose) return;
    if (hasUnsavedChangesRef.current) {
      setPendingAction({ type: 'close' });
      return;
    }
    onClose();
  }, [onClose]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-muted-foreground text-sm">Loading file tree...</span>
      </div>
    );
  }

  if (error) {
    return (
      <Alert className="my-2">
        <AlertDescription>{error?.message ?? 'Failed to load file tree'}</AlertDescription>
      </Alert>
    );
  }

  if (!tree) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => void refetch()}>
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh tree
        </Button>
        {onClose && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleClose}>
            Close
          </Button>
        )}
      </div>
      <div
        className="flex min-h-[500px] overflow-hidden rounded-md border"
        style={height ? { height } : undefined}
      >
        <div className="shrink-0 overflow-y-auto" style={{ width: `${sidebarWidth}px` }}>
          <FileTree tree={tree} selectedPath={selectedPath} onSelect={handleSelect} />
        </div>
        <div
          className="before:bg-border hover:before:bg-border relative w-3 shrink-0 cursor-col-resize before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:content-['']"
          onMouseDown={startDrag}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedPath ? (
            renderPane(selectedPath, handleDirtyChange)
          ) : (
            <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
              Select a file to edit
            </div>
          )}
        </div>
      </div>

      <AlertDialog open={pendingAction !== null} onOpenChange={() => setPendingAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>You have unsaved changes. Discard them?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                hasUnsavedChangesRef.current = false;
                if (pendingAction?.type === 'switch') {
                  setSelectedPath(pendingAction.path);
                } else if (pendingAction?.type === 'close') {
                  onClose?.();
                }
                setPendingAction(null);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
