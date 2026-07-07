import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { RadioButtonGroup } from '@/components/ui/RadioGroup';
import { LockableContainer } from '@/components/organizations/LockableContainer';
import { CollapsibleFilterSection } from '@/components/models/CollapsibleFilterSection';
import { CollapsibleCheckboxFilter } from '@/components/models/CollapsibleCheckboxFilter';
import { Info } from 'lucide-react';
import { ProviderPolicyTag } from '@/components/organizations/providers-and-models/PolicyPills';
import type { ProviderRow } from '@/components/organizations/providers-and-models/providersAndModels.types';
import type { ProviderPolicyFilter } from '@/components/organizations/providers-and-models/useProvidersAndModelsAllowListsState';

const providerPolicyFilterOptions = [
  { value: 'all', label: 'All' },
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
] satisfies Array<{ value: ProviderPolicyFilter; label: string }>;

function parseProviderPolicyFilter(value: string): ProviderPolicyFilter | null {
  if (value === 'all' || value === 'yes' || value === 'no') return value;
  return null;
}

export function ProvidersTab({
  isLoading,
  canEdit,
  search,
  enabledOnly,
  providerTrainsFilter,
  providerRetainsPromptsFilter,
  providerLocationsFilter,
  providerLocationOptions,
  filteredProviderRows,
  enabledProviderSlugs,
  enabledModelCountByProviderSlug,
  onSearchChange,
  onEnabledOnlyChange,
  onProviderTrainsFilterChange,
  onProviderRetainsPromptsFilterChange,
  onProviderLocationsFilterChange,
  onToggleProviderEnabled,
  onOpenProviderDetails,
}: {
  isLoading: boolean;
  canEdit: boolean;
  search: string;
  enabledOnly: boolean;
  providerTrainsFilter: ProviderPolicyFilter;
  providerRetainsPromptsFilter: ProviderPolicyFilter;
  providerLocationsFilter: string[];
  providerLocationOptions: string[];
  filteredProviderRows: ReadonlyArray<ProviderRow>;
  enabledProviderSlugs: ReadonlySet<string>;
  enabledModelCountByProviderSlug: ReadonlyMap<string, number>;
  onSearchChange: (value: string) => void;
  onEnabledOnlyChange: (value: boolean) => void;
  onProviderTrainsFilterChange: (value: ProviderPolicyFilter) => void;
  onProviderRetainsPromptsFilterChange: (value: ProviderPolicyFilter) => void;
  onProviderLocationsFilterChange: (value: string[]) => void;
  onToggleProviderEnabled: (providerSlug: string, nextEnabled: boolean) => void;
  onOpenProviderDetails: (providerSlug: string) => void;
}) {
  return (
    <div className="flex flex-col gap-y-4">
      <p className="text-muted-foreground text-sm">
        Enable which providers organization members can use.
      </p>

      {isLoading ? (
        <div className="text-muted-foreground flex h-40 items-center justify-center text-sm">
          Loading providers...
        </div>
      ) : (
        <LockableContainer>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex-1">
              <Input
                value={search}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Search providers…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={enabledOnly} onCheckedChange={onEnabledOnlyChange} />
              Enabled
            </label>
          </div>

          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="shrink-0 lg:w-80">
              <div className="rounded-lg border p-4">
                <div className="text-sm font-medium">Filters</div>
                <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs">Trains</div>
                    <RadioButtonGroup
                      options={providerPolicyFilterOptions}
                      value={providerTrainsFilter}
                      onChange={value => {
                        const next = parseProviderPolicyFilter(value);
                        if (next) {
                          onProviderTrainsFilterChange(next);
                        }
                      }}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="text-muted-foreground text-xs">Retains prompts</div>
                    <RadioButtonGroup
                      options={providerPolicyFilterOptions}
                      value={providerRetainsPromptsFilter}
                      onChange={value => {
                        const next = parseProviderPolicyFilter(value);
                        if (next) {
                          onProviderRetainsPromptsFilterChange(next);
                        }
                      }}
                    />
                  </div>
                </div>

                <Separator className="my-4" />

                <CollapsibleFilterSection title="Provider location" defaultExpanded={false}>
                  <CollapsibleCheckboxFilter
                    options={providerLocationOptions}
                    selected={providerLocationsFilter}
                    onChange={onProviderLocationsFilterChange}
                    maxVisible={12}
                  />
                </CollapsibleFilterSection>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="rounded-lg border">
                <div className="bg-muted/50 flex items-center justify-between gap-4 border-b px-4 py-3">
                  <div className="text-sm font-medium">Providers</div>
                  <div className="text-muted-foreground text-xs">
                    {enabledProviderSlugs.size} enabled • {filteredProviderRows.length} shown
                  </div>
                </div>

                <div className="max-h-[560px] overflow-y-auto">
                  {filteredProviderRows.map(row => {
                    const checked = enabledProviderSlugs.has(row.providerSlug);
                    const modelLabel = row.modelCount === 1 ? 'model' : 'models';
                    const enabledModelCount =
                      enabledModelCountByProviderSlug.get(row.providerSlug) ?? 0;

                    return (
                      <label
                        key={row.providerSlug}
                        className="hover:bg-muted/50 flex cursor-pointer items-start gap-3 border-b px-4 py-3 last:border-b-0"
                      >
                        <Checkbox
                          checked={checked}
                          disabled={!canEdit}
                          onCheckedChange={nextChecked => {
                            onToggleProviderEnabled(row.providerSlug, Boolean(nextChecked));
                          }}
                          className="mt-1"
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex items-start gap-2">
                            <div className="mt-0.5 h-5 w-5 shrink-0">
                              {row.providerIconUrl ? (
                                <img
                                  src={row.providerIconUrl}
                                  alt=""
                                  className="h-5 w-5 object-contain"
                                />
                              ) : null}
                            </div>
                            <div className="min-w-0">
                              <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <div className="min-w-0 truncate text-sm font-medium">
                                  {row.providerDisplayName}
                                </div>
                                <ProviderPolicyTag value={row.trains} variant="trains" />
                                <ProviderPolicyTag
                                  value={row.retainsPrompts}
                                  variant="retainsPrompts"
                                />
                              </div>
                              <div className="text-muted-foreground mt-0.5 truncate text-xs">
                                {row.providerSlug}
                              </div>
                            </div>
                          </div>

                          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5 shrink-0 p-0"
                              aria-label="View provider details"
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
                                onOpenProviderDetails(row.providerSlug);
                              }}
                            >
                              <Info className="h-4 w-4" />
                            </Button>

                            <span>
                              Offers {row.modelCount} {modelLabel}
                              {enabledModelCount > 0 ? <> • {enabledModelCount} enabled</> : null}
                            </span>
                          </div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {!canEdit ? (
            <div className="text-muted-foreground text-sm">
              Only organization owners can edit provider access.
            </div>
          ) : null}
        </LockableContainer>
      )}
    </div>
  );
}
