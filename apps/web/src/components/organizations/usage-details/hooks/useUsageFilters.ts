import { useState, useMemo } from 'react';
import type { ActiveFilter, FilterSubType, TimeseriesDataPoint } from '../types';

type UseUsageFiltersResult = {
  activeFilters: ActiveFilter[];
  showMyUsageOnly: boolean;
  setShowMyUsageOnly: (value: boolean) => void;
  filteredTimeseriesData: TimeseriesDataPoint[];
  handleFilter: (subType: FilterSubType, value: string) => void;
  handleExclude: (subType: FilterSubType, value: string) => void;
  removeFilter: (filter: ActiveFilter) => void;
  clearFilters: () => void;
};

/**
 * Manages usage data filtering state and logic.
 *
 * This hook handles both the "show my usage only" filter and the advanced
 * include/exclude filters for users, providers, and models. It applies all
 * active filters to the raw timeseries data.
 *
 * WHY: Filters must be applied to raw timeseries data BEFORE aggregation to ensure
 * accurate metrics. Applying filters after aggregation would produce incorrect totals.
 *
 * @param timeseriesData - Raw timeseries data from API
 * @param currentUserEmail - Email of the current user (for "my usage" filter)
 * @returns Filter state, filtered data, and filter manipulation functions
 */
export function useUsageFilters(
  timeseriesData: TimeseriesDataPoint[],
  currentUserEmail: string | null | undefined
): UseUsageFiltersResult {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const [showMyUsageOnly, setShowMyUsageOnly] = useState(false);

  // Apply filters to timeseries data
  const filteredTimeseriesData = useMemo(() => {
    if (!timeseriesData || !Array.isArray(timeseriesData)) {
      return [];
    }

    return timeseriesData.filter((point: TimeseriesDataPoint) => {
      // Apply "only my usage" filter if enabled
      if (showMyUsageOnly && currentUserEmail && point.email !== currentUserEmail) {
        return false;
      }

      // Group filters by subType and type
      const includeFilters = activeFilters.filter(f => f.type === 'include');
      const excludeFilters = activeFilters.filter(f => f.type === 'exclude');

      // For include filters: group by subType, use OR within each subType, AND across subTypes
      if (includeFilters.length > 0) {
        const filtersBySubType = includeFilters.reduce(
          (acc, filter) => {
            if (!acc[filter.subType]) {
              acc[filter.subType] = [];
            }
            acc[filter.subType].push(filter.value);
            return acc;
          },
          {} as Record<FilterSubType, string[]>
        );

        // Check each subType group - must match at least one filter in each group
        for (const [subType, values] of Object.entries(filtersBySubType)) {
          const matchesAny = values.some(value => {
            switch (subType) {
              case 'user':
                return point.email === value;
              case 'project':
                return (point.projectId ?? 'No Project') === value;
              case 'model':
                return point.model === value;
              default:
                return false;
            }
          });

          // If this point doesn't match any filter in this subType group, exclude it
          if (!matchesAny) {
            return false;
          }
        }
      }

      // For exclude filters: exclude if matches any
      for (const filter of excludeFilters) {
        const shouldExclude = (() => {
          switch (filter.subType) {
            case 'user':
              return point.email === filter.value;
            case 'project':
              return (point.projectId ?? 'No Project') === filter.value;
            case 'model':
              return point.model === filter.value;
            default:
              return false;
          }
        })();

        if (shouldExclude) {
          return false;
        }
      }

      return true;
    });
  }, [timeseriesData, activeFilters, showMyUsageOnly, currentUserEmail]);

  // Toggle an include filter on/off
  const handleFilter = (subType: FilterSubType, value: string) => {
    const existingFilter = activeFilters.find(
      f => f.subType === subType && f.value === value && f.type === 'include'
    );

    if (existingFilter) {
      // Remove the filter (toggle off)
      setActiveFilters(activeFilters.filter(f => f !== existingFilter));
    } else {
      // Add the filter (toggle on)
      const newFilter: ActiveFilter = {
        type: 'include',
        subType,
        value,
      };

      // Remove any existing filters for the same subType and value
      const filteredFilters = activeFilters.filter(
        f => !(f.subType === subType && f.value === value)
      );

      setActiveFilters([...filteredFilters, newFilter]);
    }
  };

  // Toggle an exclude filter on/off
  const handleExclude = (subType: FilterSubType, value: string) => {
    const existingFilter = activeFilters.find(
      f => f.subType === subType && f.value === value && f.type === 'exclude'
    );

    if (existingFilter) {
      // Remove the filter (toggle off)
      setActiveFilters(activeFilters.filter(f => f !== existingFilter));
    } else {
      // Add the filter (toggle on)
      const newFilter: ActiveFilter = {
        type: 'exclude',
        subType,
        value,
      };

      // Remove any existing filters for the same subType and value
      const filteredFilters = activeFilters.filter(
        f => !(f.subType === subType && f.value === value)
      );

      setActiveFilters([...filteredFilters, newFilter]);
    }
  };

  const removeFilter = (filter: ActiveFilter) => {
    setActiveFilters(activeFilters.filter(f => f !== filter));
  };

  const clearFilters = () => {
    setActiveFilters([]);
  };

  return {
    activeFilters,
    showMyUsageOnly,
    setShowMyUsageOnly,
    filteredTimeseriesData,
    handleFilter,
    handleExclude,
    removeFilter,
    clearFilters,
  };
}
