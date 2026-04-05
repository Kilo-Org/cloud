import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '@/components/organizations/LockableContainer';
import { Info } from 'lucide-react';
import type { ModelRow } from '@/components/organizations/providers-and-models/providersAndModels.types';

export function ModelsTab({
  isLoading,
  canEdit,
  search,
  selectedOnly,
  onSearchChange,
  onSelectedOnlyChange,
  allowedModelIds,
  enabledProviderSlugs,
  filteredModelRows,
  onToggleModelAllowed,
  onOpenModelDetails,
}: {
  isLoading: boolean;
  canEdit: boolean;
  search: string;
  selectedOnly: boolean;
  onSearchChange: (value: string) => void;
  onSelectedOnlyChange: (value: boolean) => void;
  allowedModelIds: ReadonlySet<string>;
  enabledProviderSlugs: ReadonlySet<string>;
  filteredModelRows: ReadonlyArray<ModelRow>;
  onToggleModelAllowed: (modelId: string, nextAllowed: boolean) => void;
  onOpenModelDetails: (modelId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-y-4">
      <p className="text-muted-foreground text-sm">
        Select which models organization members can use.
      </p>

      {isLoading ? (
        <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
          Loading models...
        </div>
      ) : (
        <LockableContainer>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <Input
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Search models…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={selectedOnly} onCheckedChange={onSelectedOnlyChange} />
              Selected
            </label>
          </div>

          <div className="rounded-lg border">
            <div className="bg-muted/50 flex items-center justify-between gap-4 border-b px-4 py-3">
              <div className="text-sm font-medium">Models</div>
              <div className="text-muted-foreground text-xs">
                {allowedModelIds.size} allowed • {filteredModelRows.length} shown
              </div>
            </div>

            <div className="max-h-[560px] overflow-y-auto">
              {filteredModelRows.map(row => {
                const checked = allowedModelIds.has(row.modelId);
                const providerCount = row.providerSlugs.length;
                const providerLabel = providerCount === 1 ? 'provider' : 'providers';
                const enabledProviderCount = row.providerSlugs.filter(slug =>
                  enabledProviderSlugs.has(slug)
                ).length;
                const enabledProviderEmoji = enabledProviderCount === 0 ? '⚠️' : '✅';
                return (
                  <label
                    key={row.modelId}
                    className="hover:bg-muted/50 flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!canEdit}
                      onCheckedChange={nextChecked => {
                        onToggleModelAllowed(row.modelId, Boolean(nextChecked));
                      }}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{row.modelName}</div>
                      <div className="text-muted-foreground mt-0.5 text-xs">{row.modelId}</div>
                      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 shrink-0 p-0"
                          aria-label="View model details"
                          onPointerDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onMouseDown={e => {
                            e.preventDefault();
                            e.stopPropagation();
                          }}
                          onClick={e => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenModelDetails(row.modelId);
                          }}
                        >
                          <Info className="h-4 w-4" />
                        </Button>
                        <span>
                          Available from {providerCount} {providerLabel}
                          {checked ? (
                            <>
                              {' '}
                              • {enabledProviderEmoji} {enabledProviderCount} enabled
                            </>
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>

          {!canEdit ? (
            <div className="text-muted-foreground text-sm">
              Only organization owners can edit model access.
            </div>
          ) : null}
        </LockableContainer>
      )}
    </div>
  );
}
