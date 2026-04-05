'use client';

import { useMemo, useState } from 'react';
import { useOpenRouterModelsAndProviders } from '@/app/api/openrouter/hooks';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ChevronDown, ChevronUp, Settings, Lock } from 'lucide-react';
import type { ProviderSelection } from './util';

interface CondensedProviderAndModelsListProps {
  selections: ProviderSelection[] | null;
  defaultModel?: string;
  onDefaultModelClick: () => void;
  readonly?: boolean;
}

export function CondensedProviderAndModelsList({
  selections,
  defaultModel,
  onDefaultModelClick,
  readonly = false,
}: CondensedProviderAndModelsListProps) {
  const [showAll, setShowAll] = useState(false);
  const { providers, isLoading } = useOpenRouterModelsAndProviders();

  // Create a map of provider slugs to display names for quick lookup
  const providerDisplayNames = useMemo(() => {
    const map = new Map<string, string>();
    providers.forEach(provider => {
      map.set(provider.slug, provider.displayName);
    });
    return map;
  }, [providers]);

  // Filter selections to only include providers with selected models
  const providersWithSelections = useMemo(() => {
    if (!selections) return [];

    return selections
      .filter(selection => selection.models.length > 0)
      .map(selection => ({
        slug: selection.slug,
        displayName: providerDisplayNames.get(selection.slug) || selection.slug,
        modelCount: selection.models.length,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [selections, providerDisplayNames]);

  const maxVisible = 4;
  const visibleProviders = showAll
    ? providersWithSelections
    : providersWithSelections.slice(0, maxVisible);
  const hasMore = providersWithSelections.length > maxVisible;

  if (isLoading) {
    return <div className="text-muted-foreground text-sm">Loading providers...</div>;
  }

  if (!selections || providersWithSelections.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      {/* Default model row */}
      {defaultModel ? (
        readonly ? (
          <div className="bg-muted/25 mb-6 flex items-center justify-between rounded-md border border-gray-500 px-3 py-2">
            <span className="mr-3 flex-1 truncate text-sm font-bold">{defaultModel}</span>
            <Badge variant="secondary" className="flex-shrink-0 text-xs">
              Default model
            </Badge>
          </div>
        ) : (
          <div
            onClick={onDefaultModelClick}
            className="bg-muted/25 hover:bg-muted/30 mb-6 flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 transition-all hover:border-yellow-300"
          >
            <span className="mr-3 flex-1 truncate text-sm font-bold">{defaultModel}</span>
            <Badge variant="secondary" className="flex-shrink-0 text-xs">
              Default model
            </Badge>
          </div>
        )
      ) : readonly ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="group bg-muted/10 border-muted-foreground/30 hover:border-muted-foreground/50 hover:bg-muted/20 mb-6 flex cursor-not-allowed items-center justify-between rounded-md border-2 border-dashed px-3 py-2 opacity-60 transition-all duration-200">
                <span className="text-muted-foreground mr-3 flex-1 truncate text-sm font-medium">
                  Set default model
                </span>
                <Lock className="text-muted-foreground h-4 w-4" />
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <p>
                You don't have permission to change the default model. Contact your organization
                owner to update this setting.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div
          onClick={onDefaultModelClick}
          className="group bg-muted/10 border-muted-foreground/30 hover:border-muted-foreground/50 hover:bg-muted/20 mb-6 flex cursor-pointer items-center justify-between rounded-md border-2 border-dashed px-3 py-2 transition-all duration-200"
        >
          <span className="text-muted-foreground group-hover:text-foreground mr-3 flex-1 truncate text-sm font-medium transition-colors">
            Set default model
          </span>
          <Settings className="text-muted-foreground group-hover:text-foreground h-4 w-4 transition-colors" />
        </div>
      )}

      {visibleProviders.map(provider => (
        <div key={provider.slug} className="flex items-center justify-between border-b px-3 py-2">
          <span className="mr-3 flex-1 truncate text-sm font-medium">{provider.displayName}</span>
          <Badge variant="secondary" className="flex-shrink-0 text-xs">
            {provider.modelCount} {provider.modelCount === 1 ? 'model' : 'models'}
          </Badge>
        </div>
      ))}

      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAll(!showAll)}
          className="text-muted-foreground hover:text-foreground w-full text-xs"
        >
          {showAll ? (
            <>
              <ChevronUp className="mr-1 h-3 w-3" />
              Show less
            </>
          ) : (
            <>
              <ChevronDown className="mr-1 h-3 w-3" />
              Show {providersWithSelections.length - maxVisible} more
            </>
          )}
        </Button>
      )}
    </div>
  );
}
