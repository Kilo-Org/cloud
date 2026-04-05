import { useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { AuditLogAction } from '@/lib/organizations/organization-audit-logs';

export type AuditLogsFilters = {
  action?: AuditLogAction[];
  actorEmail?: string;
  fuzzySearch?: string;
  startTime?: Date;
  endTime?: Date;
};

type UseAuditLogsFiltersProps = {
  onFiltersChange: () => void; // Function to call when filters change, typically to reset pagination
};

// Helper functions for URL parameter serialization
function serializeFiltersToParams(filters: AuditLogsFilters): URLSearchParams {
  const params = new URLSearchParams();

  if (filters.action && filters.action.length > 0) {
    params.set('action', filters.action.join(','));
  }
  if (filters.actorEmail) {
    params.set('actorEmail', filters.actorEmail);
  }
  if (filters.fuzzySearch) {
    params.set('fuzzySearch', filters.fuzzySearch);
  }
  if (filters.startTime) {
    params.set('startTime', filters.startTime.toISOString());
  }
  if (filters.endTime) {
    params.set('endTime', filters.endTime.toISOString());
  }

  return params;
}

function deserializeFiltersFromParams(searchParams: URLSearchParams): AuditLogsFilters {
  const filters: AuditLogsFilters = {};

  const actionParam = searchParams.get('action');
  if (actionParam) {
    filters.action = actionParam.split(',') as AuditLogAction[];
  }

  const actorEmailParam = searchParams.get('actorEmail');
  if (actorEmailParam) {
    filters.actorEmail = actorEmailParam;
  }

  const fuzzySearchParam = searchParams.get('fuzzySearch');
  if (fuzzySearchParam) {
    filters.fuzzySearch = fuzzySearchParam;
  }

  const startTimeParam = searchParams.get('startTime');
  if (startTimeParam) {
    try {
      const date = new Date(startTimeParam);
      if (!isNaN(date.getTime())) {
        filters.startTime = date;
      }
    } catch {
      // Ignore invalid dates
    }
  }

  const endTimeParam = searchParams.get('endTime');
  if (endTimeParam) {
    try {
      const date = new Date(endTimeParam);
      if (!isNaN(date.getTime())) {
        filters.endTime = date;
      }
    } catch {
      // Ignore invalid dates
    }
  }

  return filters;
}

export function useAuditLogsFilters({ onFiltersChange }: UseAuditLogsFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<AuditLogsFilters>({});
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize filters from URL parameters on mount
  useEffect(() => {
    const initialFilters = deserializeFiltersFromParams(searchParams);
    setFilters(initialFilters);
    setIsInitialized(true);
  }, [searchParams]);

  // Update URL when filters change (but not during initialization)
  const updateURL = useCallback(
    (newFilters: AuditLogsFilters) => {
      if (!isInitialized) return;

      const params = serializeFiltersToParams(newFilters);
      const currentUrl = new URL(window.location.href);

      // Clear existing filter params
      currentUrl.searchParams.delete('action');
      currentUrl.searchParams.delete('actorEmail');
      currentUrl.searchParams.delete('fuzzySearch');
      currentUrl.searchParams.delete('startTime');
      currentUrl.searchParams.delete('endTime');

      // Add new filter params
      params.forEach((value, key) => {
        currentUrl.searchParams.set(key, value);
      });

      // Use replace to avoid pushing to history
      router.replace(currentUrl.pathname + currentUrl.search, { scroll: false });
    },
    [router, isInitialized]
  );

  const setFilter = useCallback(
    <K extends keyof AuditLogsFilters>(key: K, value: AuditLogsFilters[K]) => {
      setFilters(prevFilters => {
        const newFilters = { ...prevFilters, [key]: value };

        // Check if filters actually changed to avoid unnecessary resets
        const filtersChanged = JSON.stringify(prevFilters) !== JSON.stringify(newFilters);

        if (filtersChanged) {
          // Update URL with new filters
          updateURL(newFilters);
          // If any filter changes, reset pagination
          onFiltersChange();
        }

        return newFilters;
      });
    },
    [onFiltersChange, updateURL]
  );

  const clearFilters = useCallback(() => {
    const emptyFilters = {};
    setFilters(emptyFilters);
    updateURL(emptyFilters);
    onFiltersChange();
  }, [onFiltersChange, updateURL]);

  // Helper to update specific fields without triggering reset logic inside setFilter if we know we are just setting initial state or clearing
  const setFiltersState = useCallback(
    (newFilters: AuditLogsFilters) => {
      setFilters(newFilters);
      updateURL(newFilters);
    },
    [updateURL]
  );

  return {
    filters,
    setFilter,
    setFiltersState,
    clearFilters,
  };
}
