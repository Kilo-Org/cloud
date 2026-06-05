'use client';

import { useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
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

function replaceDirectoryChildren(
  nodes: FileNode[],
  path: string,
  children: FileNode[]
): FileNode[] {
  return nodes.map(node => {
    if (node.path === path && node.type === 'directory') {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: replaceDirectoryChildren(node.children, path, children) };
    }
    return node;
  });
}

function stripNestedChildren(nodes: FileNode[]): FileNode[] {
  return nodes.map(node => {
    if (node.type === 'directory') {
      return { name: node.name, path: node.path, type: node.type };
    }
    return node;
  });
}

function indexNodesByPath(nodes: FileNode[], index = new Map<string, FileNode>()) {
  for (const node of nodes) {
    index.set(node.path, node);
    if (node.children) indexNodesByPath(node.children, index);
  }
  return index;
}

function preserveLoadedDirectoryChildren(nodes: FileNode[], existingNodes: FileNode[]): FileNode[] {
  const existingByPath = indexNodesByPath(existingNodes);
  return nodes.map(node => {
    if (node.type !== 'directory') return node;

    const existing = existingByPath.get(node.path);
    if (!existing?.children) return node;

    return { ...node, children: existing.children };
  });
}

function validatePathScopedChildren(path: string, children: FileNode[]): void {
  const prefix = `${path}/`;
  if (children.every(child => child.path.startsWith(prefix))) return;

  throw new Error(
    'Controller returned a recursive file tree. Restart this instance with the latest image.'
  );
}

export function FileEditorShell({
  tree,
  isLoading,
  error,
  refetch,
  loadChildren,
  renderPane,
  onClose,
  height,
}: {
  tree: FileNode[] | undefined;
  isLoading: boolean;
  error: { message: string } | null;
  refetch: () => void;
  loadChildren?: (path: string) => Promise<FileNode[]>;
  renderPane: (selectedPath: string, onDirtyChange: (dirty: boolean) => void) => ReactNode;
  onClose?: () => void;
  height?: string;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    { type: 'switch'; path: string } | { type: 'close' } | null
  >(null);
  const [mergedTree, setMergedTree] = useState<FileNode[] | undefined>(tree);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedPaths, setLoadedPaths] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(new Map());
  const expandedPathsRef = useRef(new Set<string>());
  const loadedPathsRef = useRef(new Set<string>());
  const loadingPathsRef = useRef(new Set<string>());
  const hasUnsavedChangesRef = useRef(false);
  const { width: sidebarWidth, startDrag } = useResizableSidebar();

  useEffect(() => {
    if (!tree) {
      setMergedTree(tree);
      expandedPathsRef.current = new Set();
      loadedPathsRef.current = new Set();
      loadingPathsRef.current = new Set();
      setExpandedPaths(expandedPathsRef.current);
      setLoadedPaths(loadedPathsRef.current);
      setLoadingPaths(loadingPathsRef.current);
      setLoadErrors(new Map());
      return;
    }

    const shallowTree = stripNestedChildren(tree);
    setMergedTree(prev =>
      prev ? preserveLoadedDirectoryChildren(shallowTree, prev) : shallowTree
    );
    setLoadErrors(new Map());
  }, [tree]);

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

  const handleLoadChildren = useCallback(
    async (path: string) => {
      if (!loadChildren || loadingPathsRef.current.has(path) || loadedPathsRef.current.has(path)) {
        return;
      }

      const nextLoadingPaths = new Set(loadingPathsRef.current).add(path);
      loadingPathsRef.current = nextLoadingPaths;
      setLoadingPaths(nextLoadingPaths);
      setLoadErrors(prev => {
        const next = new Map(prev);
        next.delete(path);
        return next;
      });

      try {
        const children = await loadChildren(path);
        validatePathScopedChildren(path, children);
        const shallowChildren = stripNestedChildren(children);
        setMergedTree(prev =>
          prev ? replaceDirectoryChildren(prev, path, shallowChildren) : prev
        );
        const nextLoadedPaths = new Set(loadedPathsRef.current).add(path);
        loadedPathsRef.current = nextLoadedPaths;
        setLoadedPaths(nextLoadedPaths);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load folder';
        setLoadErrors(prev => new Map(prev).set(path, message));
      } finally {
        const nextLoadingPaths = new Set(loadingPathsRef.current);
        nextLoadingPaths.delete(path);
        loadingPathsRef.current = nextLoadingPaths;
        setLoadingPaths(nextLoadingPaths);
      }
    },
    [loadChildren]
  );

  const handleToggleDirectory = useCallback(
    (node: FileNode) => {
      if (node.type !== 'directory') return;

      const isExpanded = expandedPathsRef.current.has(node.path);
      const nextExpandedPaths = new Set(expandedPathsRef.current);
      if (isExpanded) {
        nextExpandedPaths.delete(node.path);
      } else {
        nextExpandedPaths.add(node.path);
      }
      expandedPathsRef.current = nextExpandedPaths;
      setExpandedPaths(nextExpandedPaths);

      if (!isExpanded) void handleLoadChildren(node.path);
    },
    [handleLoadChildren]
  );

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

  const visibleTree = mergedTree ?? tree;

  if (!visibleTree) return null;

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
          <FileTree
            tree={visibleTree}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            loadedPaths={loadedPaths}
            loadingPaths={loadingPaths}
            loadErrors={loadErrors}
            onSelect={handleSelect}
            onLoadChildren={loadChildren ? path => void handleLoadChildren(path) : undefined}
            onToggleDirectory={handleToggleDirectory}
          />
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
