'use client';

import { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Search } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useTRPC } from '@/lib/trpc/utils';
import type { McpBrowseItem, McpBrowseVariant } from './guardrail-types';
import { useDebouncedValue } from './use-debounced-value';

export type McpRegistrySource = 'kilo_marketplace' | 'mcp_registry';

export type McpSelection = {
  key: string;
  source: McpRegistrySource;
  sourceId: string;
  identityKey: string;
  name: string;
  isPackage: boolean;
  minVersion: string;
};

export type McpSelectionState = Record<string, McpSelection>;

export function selectionKey(source: McpRegistrySource, sourceId: string, identityKey: string) {
  return `${source}|${sourceId}|${identityKey}`;
}

function targetKindLabel(variant: Extract<McpBrowseVariant, { eligible: true }>): string {
  if (variant.target.kind === 'remote') return 'Remote';
  return variant.target.ecosystem === 'npm' ? 'npm' : 'PyPI';
}

function targetIdentity(variant: Extract<McpBrowseVariant, { eligible: true }>): string {
  return variant.target.kind === 'remote' ? variant.target.url : variant.target.identifier;
}

export function McpRegistryPicker({
  organizationId,
  source,
  selection,
  onToggle,
  onMinVersionChange,
}: {
  organizationId: string;
  source: McpRegistrySource;
  selection: McpSelectionState;
  onToggle: (
    item: McpBrowseItem,
    variant: Extract<McpBrowseVariant, { eligible: true }>,
    checked: boolean
  ) => void;
  onMinVersionChange: (key: string, minVersion: string) => void;
}) {
  const trpc = useTRPC();
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 300);

  const browseQuery = useInfiniteQuery(
    trpc.organizations.mcpGuardrails.browse.infiniteQueryOptions(
      { organizationId, type: 'mcp', source, query },
      { getNextPageParam: page => page.nextCursor ?? undefined }
    )
  );
  const items = browseQuery.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <div className="grid gap-3">
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={search}
          placeholder={
            source === 'kilo_marketplace' ? 'Search the Kilo registry' : 'Search the MCP registry'
          }
          aria-label="Search registry"
          className="pl-9"
          onChange={event => setSearch(event.target.value)}
        />
      </div>

      <div className="grid max-h-[45vh] gap-2 overflow-y-auto pr-1">
        {browseQuery.isPending ? (
          <div aria-busy="true" className="grid gap-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : browseQuery.isError ? (
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>The registry couldn’t be searched</AlertTitle>
            <AlertDescription className="grid gap-3">
              <span>{browseQuery.error.message}</span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => void browseQuery.refetch()}
              >
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            No servers match “{query}”. Try a different search, or add it with Custom.
          </p>
        ) : (
          <>
            {items.map(item => (
              <RegistryItem
                key={`${item.source}|${item.sourceId}`}
                item={item}
                selection={selection}
                onToggle={onToggle}
                onMinVersionChange={onMinVersionChange}
              />
            ))}
            {browseQuery.hasNextPage && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit self-center"
                disabled={browseQuery.isFetchingNextPage}
                onClick={() => void browseQuery.fetchNextPage()}
              >
                {browseQuery.isFetchingNextPage ? 'Loading more…' : 'Load more'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function RegistryItem({
  item,
  selection,
  onToggle,
  onMinVersionChange,
}: {
  item: McpBrowseItem;
  selection: McpSelectionState;
  onToggle: (
    item: McpBrowseItem,
    variant: Extract<McpBrowseVariant, { eligible: true }>,
    checked: boolean
  ) => void;
  onMinVersionChange: (key: string, minVersion: string) => void;
}) {
  return (
    <div className="grid gap-2 rounded-md border p-3">
      <div className="grid gap-0.5">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.homepageUrl && (
            <a
              href={item.homepageUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${item.name} documentation`}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        {item.description && (
          <p className="text-muted-foreground line-clamp-2 text-xs">{item.description}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        {item.variants.length === 0 && (
          <p className="text-muted-foreground text-xs">This server has no installable options.</p>
        )}
        {item.variants.map((variant, index) => {
          if (!variant.eligible) {
            return (
              <div key={index} className="flex items-start gap-3 opacity-70">
                <Checkbox disabled className="mt-0.5" aria-label={variant.label} />
                <span className="grid min-w-0 gap-0.5">
                  <span className="truncate text-xs">{variant.label}</span>
                  <span className="text-muted-foreground text-xs">{variant.reason}</span>
                </span>
              </div>
            );
          }
          const key = selectionKey(item.source, item.sourceId, variant.identityKey);
          const selected = selection[key];
          return (
            <div key={variant.identityKey} className="grid gap-1.5">
              <label className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5"
                  checked={selected !== undefined || variant.alreadyAdded}
                  disabled={variant.alreadyAdded}
                  onCheckedChange={checked => onToggle(item, variant, checked)}
                />
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <Badge variant="outline">{targetKindLabel(variant)}</Badge>
                  <code className="truncate font-mono text-xs">{targetIdentity(variant)}</code>
                  {variant.alreadyAdded && <Badge variant="secondary">Allowed</Badge>}
                </span>
              </label>
              {selected?.isPackage && (
                <div className="flex items-center gap-2 pl-7">
                  <label
                    htmlFor={`min-version-${key}`}
                    className="text-muted-foreground text-xs whitespace-nowrap"
                  >
                    Minimum version
                  </label>
                  <Input
                    id={`min-version-${key}`}
                    value={selected.minVersion}
                    placeholder="Any version"
                    className="h-8 w-36"
                    onChange={event => onMinVersionChange(key, event.target.value)}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
