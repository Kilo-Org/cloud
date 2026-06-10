'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Check, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DIMENSION_LABELS, type CostSource, type Dimension, type FilterDirection } from './types';
import { useResolveOrgUsers, type DateRange, type PersonalScope, type UsageFilters } from './hooks';
import type { Granularity } from './types';

type FilterGeneratorPopoverProps = {
  /** Query scope (to populate value suggestions). */
  organizationId: string | null;
  dateRange: DateRange;
  personalScope: PersonalScope;
  /**
   * Include the `user` dimension in the field selector. Should be true only
   * when the caller may legitimately see multiple users' usage (org context
   * with owner/billing_manager role viewing the entire org).
   */
  canFilterByUser: boolean;
  /**
   * Scope applied to the breakdown query that populates the value suggestions.
   * When `'self'`, the server will restrict suggestions to the caller's own
   * rows — matching the rest of the dashboard's view.
   */
  viewAs: 'self' | 'org-wide';
  /** Active filters — disables re-adding an already-active value. */
  activeFilters: UsageFilters;
  onAdd: (dimension: Dimension, direction: FilterDirection, value: string) => void;
  /** Resolves IDs (e.g. user UUIDs) to display labels for suggestions. */
  labelForDimensionValue?: (dim: Dimension, value: string) => string;
  /** Metric used to rank breakdown suggestions (defaults to 'cost'). */
  metric?: 'cost' | 'requests' | 'tokens';
  costSource: CostSource;
  /** Granularity for the breakdown query (defaults to 'day'). */
  granularity?: Granularity;
};

const DIMENSIONS_PERSONAL: Dimension[] = ['feature', 'model', 'mode', 'provider', 'project'];
const DIMENSIONS_ORG: Dimension[] = ['feature', 'model', 'mode', 'user', 'provider', 'project'];

export function FilterGeneratorPopover({
  organizationId,
  dateRange,
  personalScope,
  canFilterByUser,
  viewAs,
  activeFilters,
  onAdd,
  labelForDimensionValue,
  metric = 'cost',
  costSource,
  granularity = 'day',
}: FilterGeneratorPopoverProps) {
  const [open, setOpen] = useState(false);
  const [dimension, setDimension] = useState<Dimension>('feature');
  const [direction, setDirection] = useState<FilterDirection>('include');

  const dimensionOptions = canFilterByUser ? DIMENSIONS_ORG : DIMENSIONS_PERSONAL;

  const trpc = useTRPC();
  const { data: breakdown, isLoading } = useQuery({
    ...trpc.usageAnalytics.getBreakdown.queryOptions({
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      granularity,
      costSource,
      organizationId: organizationId ?? undefined,
      personalScope,
      viewAs,
      dimension,
      metric,
      limit: 100,
    }),
    enabled: open,
  });

  const suggestionKeys = useMemo(
    () => (breakdown?.breakdown ?? []).filter(i => i.key).map(i => i.key),
    [breakdown]
  );
  const userSuggestionIds = useMemo(
    () => (dimension === 'user' ? suggestionKeys : []),
    [dimension, suggestionKeys]
  );
  const { data: userSuggestionResolution, isLoading: userSuggestionResolutionLoading } =
    useResolveOrgUsers(organizationId, userSuggestionIds);
  const isResolvingUserSuggestions =
    dimension === 'user' && userSuggestionIds.length > 0 && userSuggestionResolutionLoading;
  const resolvedUsersById = useMemo(
    () => new Map(userSuggestionResolution?.users.map(user => [user.id, user]) ?? []),
    [userSuggestionResolution]
  );

  const suggestions = useMemo(
    () =>
      suggestionKeys.map(key => {
        const resolvedUser = resolvedUsersById.get(key);
        return {
          key,
          label:
            resolvedUser?.email ||
            resolvedUser?.name ||
            (labelForDimensionValue ? labelForDimensionValue(dimension, key) : key),
        };
      }),
    [dimension, labelForDimensionValue, resolvedUsersById, suggestionKeys]
  );

  const activeSet = useMemo(() => {
    const keyFor = (d: Dimension, dir: FilterDirection): keyof UsageFilters => {
      switch (d) {
        case 'feature':
          return dir === 'include' ? 'features' : 'excludedFeatures';
        case 'model':
          return dir === 'include' ? 'models' : 'excludedModels';
        case 'mode':
          return dir === 'include' ? 'modes' : 'excludedModes';
        case 'user':
          return dir === 'include' ? 'userIds' : 'excludedUserIds';
        case 'provider':
          return dir === 'include' ? 'providers' : 'excludedProviders';
        case 'project':
          return dir === 'include' ? 'projects' : 'excludedProjects';
      }
    };
    return new Set((activeFilters[keyFor(dimension, direction)] as string[]) ?? []);
  }, [activeFilters, dimension, direction]);

  const handleSelect = (value: string): void => {
    onAdd(dimension, direction, value);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-full justify-start">
          <Plus className="mr-2 h-3.5 w-3.5" />
          Add filter
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="flex flex-col gap-2 border-b p-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs">Field</span>
            <Select value={dimension} onValueChange={v => setDimension(v as Dimension)}>
              <SelectTrigger className="h-8 flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {dimensionOptions.map(d => (
                  <SelectItem key={d} value={d}>
                    {DIMENSION_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant={direction === 'include' ? 'default' : 'outline'}
              className="h-7 flex-1 text-xs"
              onClick={() => setDirection('include')}
            >
              Include
            </Button>
            <Button
              size="sm"
              variant={direction === 'exclude' ? 'default' : 'outline'}
              className="h-7 flex-1 text-xs"
              onClick={() => setDirection('exclude')}
            >
              Exclude
            </Button>
          </div>
        </div>
        <Command>
          <CommandInput placeholder={`Search ${DIMENSION_LABELS[dimension].toLowerCase()}…`} />
          <CommandList>
            {isLoading || isResolvingUserSuggestions ? (
              <div className="text-muted-foreground px-2 py-6 text-center text-sm">Loading…</div>
            ) : (
              <>
                <CommandEmpty>No values found.</CommandEmpty>
                <CommandGroup>
                  {suggestions.map(s => {
                    const alreadyActive = activeSet.has(s.key);
                    return (
                      <CommandItem
                        key={s.key}
                        value={`${s.key} ${s.label}`}
                        onSelect={() => handleSelect(s.key)}
                        disabled={alreadyActive}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            alreadyActive ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate">{s.label}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
