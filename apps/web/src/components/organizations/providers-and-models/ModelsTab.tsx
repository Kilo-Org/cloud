import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LockableContainer } from '@/components/organizations/LockableContainer';
import { Info } from 'lucide-react';
import type { ModelRow } from '@/components/organizations/providers-and-models/providersAndModels.types';
import { ByokOnlyTag } from '@/components/organizations/providers-and-models/PolicyPills';

const NO_PROVIDERS: ReadonlySet<string> = new Set();

export function ModelsTab({
  isLoading,
  canEdit,
  search,
  enabledOnly,
  onSearchChange,
  onEnabledOnlyChange,
  allowedModelIds,
  enabledProviderSlugs,
  byokOnlyProviderSlugs = NO_PROVIDERS,
  filteredModelRows,
  onToggleModelAllowed,
  onSetModelsAllowed,
  onOpenModelDetails,
  scope = 'organization',
  showDetails = true,
}: {
  isLoading: boolean;
  canEdit: boolean;
  search: string;
  enabledOnly: boolean;
  onSearchChange: (value: string) => void;
  onEnabledOnlyChange: (value: boolean) => void;
  allowedModelIds: ReadonlySet<string>;
  enabledProviderSlugs: ReadonlySet<string>;
  /** Enabled providers among these only serve the organization's own keys. */
  byokOnlyProviderSlugs?: ReadonlySet<string>;
  filteredModelRows: ReadonlyArray<ModelRow>;
  onToggleModelAllowed: (modelId: string, nextAllowed: boolean) => void;
  onSetModelsAllowed: (modelIds: string[], nextAllowed: boolean) => void;
  onOpenModelDetails: (modelId: string) => void;
  scope?: 'organization' | 'group';
  showDetails?: boolean;
}) {
  const modelsToEnable = filteredModelRows
    .filter(row => !row.unavailableReason && !allowedModelIds.has(row.modelId))
    .map(row => row.modelId);
  const modelsToDisable = filteredModelRows
    .filter(row => allowedModelIds.has(row.modelId))
    .map(row => row.modelId);

  return (
    <div className="flex flex-col gap-y-4">
      <p className="text-muted-foreground text-sm">
        {scope === 'organization'
          ? 'Disable specific models for organization members. New models from enabled providers are enabled by default.'
          : 'Grant specific models in addition to the organization default access.'}
      </p>

      {isLoading ? (
        <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
          Loading models...
        </div>
      ) : (
        <LockableContainer>
          <div className="rounded-lg border">
            <div className="bg-muted/50 flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div className="text-sm font-medium">Models</div>
              <div className="text-muted-foreground text-xs">
                {allowedModelIds.size} enabled • {filteredModelRows.length} shown
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
              <Input
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
                className="min-w-40 flex-1"
              />
              <label className="flex shrink-0 items-center gap-2 text-sm">
                <Checkbox checked={enabledOnly} onCheckedChange={onEnabledOnlyChange} />
                Show enabled only
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canEdit || modelsToEnable.length === 0}
                  onClick={() => onSetModelsAllowed(modelsToEnable, true)}
                >
                  Enable all shown ({modelsToEnable.length})
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!canEdit || modelsToDisable.length === 0}
                  onClick={() => onSetModelsAllowed(modelsToDisable, false)}
                >
                  Disable all shown ({modelsToDisable.length})
                </Button>
              </div>
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              {filteredModelRows.map(row => {
                const checked = allowedModelIds.has(row.modelId);
                const providerCount = row.providerSlugs.length;
                const providerLabel = providerCount === 1 ? 'provider' : 'providers';
                const enabledProviders = row.providerSlugs.filter(slug =>
                  enabledProviderSlugs.has(slug)
                );
                const enabledProviderCount = enabledProviders.length;
                const enabledByokOnly =
                  enabledProviderCount > 0 &&
                  enabledProviders.every(slug => byokOnlyProviderSlugs.has(slug));
                const enabledProviderEmoji = enabledProviderCount === 0 ? '⚠️' : '✅';
                const unavailable = Boolean(row.unavailableReason);
                return (
                  <label
                    key={row.modelId}
                    className="hover:bg-muted/50 flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <Checkbox
                      checked={checked}
                      disabled={!canEdit || (unavailable && !checked)}
                      onCheckedChange={nextChecked => {
                        onToggleModelAllowed(row.modelId, Boolean(nextChecked));
                      }}
                      className="mt-1"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{row.modelName}</div>
                      <div className="text-muted-foreground mt-0.5 text-xs">{row.modelId}</div>
                      {row.unavailableReason && (
                        <div className="type-label text-status-warning mt-1">
                          {row.unavailableReason}
                        </div>
                      )}
                      <div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                        {showDetails && (
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
                        )}
                        <span>
                          Available from {providerCount} {providerLabel}
                          {scope === 'organization' && checked ? (
                            <>
                              {' '}
                              • {enabledProviderEmoji} {enabledProviderCount} enabled
                            </>
                          ) : null}
                        </span>
                        {scope === 'organization' && checked ? (
                          <ByokOnlyTag value={enabledByokOnly} />
                        ) : null}
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
