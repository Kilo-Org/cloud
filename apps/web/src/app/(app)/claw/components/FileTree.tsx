'use client';

import { ChevronRight, ChevronDown, File, Folder, Loader2 } from 'lucide-react';
import type { FileNode } from '@/lib/kiloclaw/kiloclaw-internal-client';

function sortNodes(nodes: FileNode[]): FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });
}

function FileTreeNode({
  node,
  depth,
  selectedPath,
  expanded,
  loadedPaths,
  loadingPaths,
  loadErrors,
  onSelect,
  onToggle,
  onLoadChildren,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expanded: ReadonlySet<string>;
  loadedPaths: ReadonlySet<string>;
  loadingPaths: ReadonlySet<string>;
  loadErrors: ReadonlyMap<string, string>;
  onSelect: (path: string) => void;
  onToggle: (node: FileNode) => void;
  onLoadChildren?: (path: string) => void;
}) {
  const isDir = node.type === 'directory';
  const isExpanded = expanded.has(node.path);
  const isSelected = node.path === selectedPath;
  const isLoading = loadingPaths.has(node.path);
  const loadError = loadErrors.get(node.path);

  return (
    <>
      <button
        type="button"
        className={`hover:bg-accent/50 flex w-full items-center gap-1 px-2 py-1 text-left text-xs ${
          isSelected ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isDir) {
            onToggle(node);
          } else {
            onSelect(node.path);
          }
        }}
      >
        {isDir ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0" />
          )
        ) : (
          <File className="h-3 w-3 shrink-0" />
        )}
        {isDir && <Folder className="h-3 w-3 shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {isDir &&
        isExpanded &&
        (isLoading ? (
          <div
            className="text-muted-foreground flex items-center gap-1 px-2 py-1 text-xs"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          >
            <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
            <span className="truncate">Loading...</span>
          </div>
        ) : loadError ? (
          <button
            type="button"
            className="text-destructive hover:bg-accent/50 flex w-full items-center gap-1 px-2 py-1 text-left text-xs"
            style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            onClick={() => onLoadChildren?.(node.path)}
          >
            <span className="truncate">{loadError}. Retry</span>
          </button>
        ) : (
          sortNodes(node.children ?? []).map(child => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              loadedPaths={loadedPaths}
              loadingPaths={loadingPaths}
              loadErrors={loadErrors}
              onSelect={onSelect}
              onToggle={onToggle}
              onLoadChildren={onLoadChildren}
            />
          ))
        ))}
    </>
  );
}

export function FileTree({
  tree,
  selectedPath,
  expandedPaths,
  loadedPaths = new Set(),
  loadingPaths = new Set(),
  loadErrors = new Map(),
  onSelect,
  onLoadChildren,
  onToggleDirectory,
}: {
  tree: FileNode[];
  selectedPath: string | null;
  expandedPaths: ReadonlySet<string>;
  loadedPaths?: ReadonlySet<string>;
  loadingPaths?: ReadonlySet<string>;
  loadErrors?: ReadonlyMap<string, string>;
  onSelect: (path: string) => void;
  onLoadChildren?: (path: string) => void;
  onToggleDirectory: (node: FileNode) => void;
}) {
  return (
    <div className="flex flex-col overflow-y-auto">
      <div className="text-muted-foreground px-3 py-2 text-[10px] font-medium tracking-wider uppercase">
        /root/.openclaw
      </div>
      {sortNodes(tree).map(node => (
        <FileTreeNode
          key={node.path}
          node={node}
          depth={0}
          selectedPath={selectedPath}
          expanded={expandedPaths}
          loadedPaths={loadedPaths}
          loadingPaths={loadingPaths}
          loadErrors={loadErrors}
          onSelect={onSelect}
          onToggle={onToggleDirectory}
          onLoadChildren={onLoadChildren}
        />
      ))}
    </div>
  );
}
