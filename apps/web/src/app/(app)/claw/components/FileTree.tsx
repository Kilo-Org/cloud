'use client';

import { useState, useCallback } from 'react';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';
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
  onSelect,
  onToggle,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expanded: Set<string>;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
}) {
  const isDir = node.type === 'directory';
  const isExpanded = expanded.has(node.path);
  const isSelected = node.path === selectedPath;

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
            onToggle(node.path);
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
        sortNodes(node.children ?? []).map(child => (
          <FileTreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            expanded={expanded}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}

export function FileTree({
  tree,
  selectedPath,
  onSelect,
}: {
  tree: FileNode[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const handleToggle = useCallback((path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

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
          expanded={expanded}
          onSelect={onSelect}
          onToggle={handleToggle}
        />
      ))}
    </div>
  );
}
