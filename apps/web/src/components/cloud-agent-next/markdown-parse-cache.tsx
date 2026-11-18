'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Options } from 'react-markdown';

/**
 * Types are derived from react-markdown's public options so we can wrap the
 * parser unified installs without depending on undeclared transitive packages.
 */
export type MarkdownRemarkPlugin = Extract<
  NonNullable<Options['remarkPlugins']>[number],
  (...parameters: never[]) => unknown
>;

type MarkdownProcessor = ThisParameterType<MarkdownRemarkPlugin>;
type MarkdownParser = NonNullable<MarkdownProcessor['parser']>;
export type MarkdownParseTree = ReturnType<MarkdownParser>;

const DEFAULT_MARKDOWN_PARSE_CACHE_BOUNDS = {
  maxEntries: 128,
  maxSourceUnits: 2_097_152,
} as const;

export type MarkdownParseCacheBounds = {
  maxEntries: number;
  maxSourceUnits: number;
};

export type MarkdownParseCache = {
  get(source: string): MarkdownParseTree | undefined;
  set(source: string, tree: MarkdownParseTree): void;
  clear(): void;
  readonly size: number;
  readonly sourceUnits: number;
};

type CacheEntry = {
  sourceUnits: number;
  tree: MarkdownParseTree;
};

export function createMarkdownParseCache(
  bounds: MarkdownParseCacheBounds = DEFAULT_MARKDOWN_PARSE_CACHE_BOUNDS
): MarkdownParseCache {
  const entries = new Map<string, CacheEntry>();
  let sourceUnits = 0;

  return {
    get(source) {
      const entry = entries.get(source);
      if (!entry) return undefined;
      entries.delete(source);
      entries.set(source, entry);
      return entry.tree;
    },

    set(source, tree) {
      const incomingUnits = source.length;
      if (incomingUnits > bounds.maxSourceUnits) return;
      const snapshot = cloneMarkdownParseTree(tree);
      if (!snapshot) return;

      const previous = entries.get(source);
      if (previous) {
        entries.delete(source);
        sourceUnits -= previous.sourceUnits;
      }

      entries.set(source, { sourceUnits: incomingUnits, tree: snapshot });
      sourceUnits += incomingUnits;

      while (entries.size > bounds.maxEntries || sourceUnits > bounds.maxSourceUnits) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) break;
        const oldest = entries.get(oldestKey);
        entries.delete(oldestKey);
        if (oldest) sourceUnits -= oldest.sourceUnits;
      }
    },

    clear() {
      entries.clear();
      sourceUnits = 0;
    },

    get size() {
      return entries.size;
    },

    get sourceUnits() {
      return sourceUnits;
    },
  };
}

function cloneMarkdownParseTree(tree: MarkdownParseTree): MarkdownParseTree | undefined {
  try {
    return structuredClone(tree);
  } catch {
    return undefined;
  }
}

// Snapshot before transformers run; downstream plugins can mutate their input.
export function createMarkdownParseCachePlugin(cache: MarkdownParseCache): MarkdownRemarkPlugin {
  return function markdownParseCachePlugin(this: MarkdownProcessor) {
    const parser = this.parser;
    if (!parser) return;

    const cachedParser: MarkdownParser = (document, file) => {
      const cached = cache.get(document);
      if (cached) {
        const cachedClone = cloneMarkdownParseTree(cached);
        if (cachedClone) return cachedClone;
      }

      const tree = parser(document, file);
      cache.set(document, tree);
      return tree;
    };

    this.parser = cachedParser;
  };
}

const MarkdownParseCacheContext = createContext<MarkdownParseCache | null>(null);

export function MarkdownParseCacheProvider({ children }: { children: ReactNode }) {
  const [cache] = useState(createMarkdownParseCache);

  useEffect(() => () => cache.clear(), [cache]);

  return (
    <MarkdownParseCacheContext.Provider value={cache}>
      {children}
    </MarkdownParseCacheContext.Provider>
  );
}

export function useMarkdownParseCache(): MarkdownParseCache | null {
  return useContext(MarkdownParseCacheContext);
}
