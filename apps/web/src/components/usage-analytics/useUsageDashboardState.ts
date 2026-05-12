import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { PeriodOption, Granularity, MetricKey, Dimension } from './types';
import type { UsageFilters } from './hooks';
import { EMPTY_FILTERS } from './hooks';

export type DashboardState = {
  period: PeriodOption;
  granularity: Granularity;
  chartMetric: MetricKey;
  filters: UsageFilters;
  groupBy: Dimension | 'none';
  personalView: string;
  viewAs: 'self' | 'org-wide';
};

const VALID_PERIODS: PeriodOption[] = ['today', 'yesterday', '7d', '30d', '1y'];
const VALID_GRANULARITIES: Granularity[] = ['hour', 'day', 'week', 'month'];
const VALID_DIMENSIONS: Dimension[] = ['feature', 'model', 'mode', 'user', 'provider', 'project'];

const INCLUDE_DIM_KEYS: (keyof UsageFilters)[] = [
  'features',
  'models',
  'modes',
  'userIds',
  'providers',
  'projects',
];

const EXCLUDE_DIM_KEYS: (keyof UsageFilters)[] = [
  'excludedFeatures',
  'excludedModels',
  'excludedModes',
  'excludedUserIds',
  'excludedProviders',
  'excludedProjects',
];

const DIM_KEY_TO_NAME: Record<string, Dimension> = {
  features: 'feature',
  models: 'model',
  modes: 'mode',
  userIds: 'user',
  providers: 'provider',
  projects: 'project',
  excludedFeatures: 'feature',
  excludedModels: 'model',
  excludedModes: 'mode',
  excludedUserIds: 'user',
  excludedProviders: 'provider',
  excludedProjects: 'project',
};

function serializeFiltersToParams(params: URLSearchParams, filters: UsageFilters): void {
  // Clear existing filter params
  [...params.keys()].forEach(key => {
    if (key.startsWith('filter.')) params.delete(key);
  });

  for (const key of INCLUDE_DIM_KEYS) {
    const values = filters[key];
    if (values.length > 0) {
      params.set(`filter.include.${DIM_KEY_TO_NAME[key]}`, values.join(','));
    }
  }
  for (const key of EXCLUDE_DIM_KEYS) {
    const values = filters[key];
    if (values.length > 0) {
      params.set(`filter.exclude.${DIM_KEY_TO_NAME[key]}`, values.join(','));
    }
  }
}

function deserializeFiltersFromParams(params: URLSearchParams): UsageFilters {
  const filters: UsageFilters = { ...EMPTY_FILTERS };

  for (const [key, value] of params.entries()) {
    if (!key.startsWith('filter.')) continue;

    const match = key.match(/^filter\.(include|exclude)\.(.+)$/);
    if (!match) continue;

    const [, direction, dimName] = match;
    const values = value.split(',').filter(Boolean);
    if (values.length === 0) continue;

    const dim = dimName as Dimension;
    if (!VALID_DIMENSIONS.includes(dim)) continue;

    if (direction === 'include') {
      switch (dim) {
        case 'feature':
          filters.features = values;
          break;
        case 'model':
          filters.models = values;
          break;
        case 'mode':
          filters.modes = values;
          break;
        case 'user':
          filters.userIds = values;
          break;
        case 'provider':
          filters.providers = values;
          break;
        case 'project':
          filters.projects = values;
          break;
      }
    } else {
      switch (dim) {
        case 'feature':
          filters.excludedFeatures = values;
          break;
        case 'model':
          filters.excludedModels = values;
          break;
        case 'mode':
          filters.excludedModes = values;
          break;
        case 'user':
          filters.excludedUserIds = values;
          break;
        case 'provider':
          filters.excludedProviders = values;
          break;
        case 'project':
          filters.excludedProjects = values;
          break;
      }
    }
  }

  return filters;
}

function isValidMetricKey(value: string): value is MetricKey {
  return [
    'cost',
    'requests',
    'tokens',
    'inputTokens',
    'outputTokens',
    'costPerRequest',
    'tokensPerRequest',
    'errorRate',
    'avgLatencyMs',
    'avgGenerationTimeMs',
    'cacheHitRatio',
    'outputInputRatio',
  ].includes(value);
}

function isValidDimension(value: string): value is Dimension {
  return VALID_DIMENSIONS.includes(value as Dimension);
}

export function useUsageDashboardState(defaultState?: Partial<DashboardState>): {
  state: DashboardState;
  setState: (updates: Partial<DashboardState>) => void;
} {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [state, setStateInternal] = useState<DashboardState>(() => {
    const params = new URLSearchParams(searchParams.toString());

    const period = VALID_PERIODS.includes(params.get('period') as PeriodOption)
      ? (params.get('period') as PeriodOption)
      : (defaultState?.period ?? ('today' as PeriodOption));

    const granularity = VALID_GRANULARITIES.includes(params.get('granularity') as Granularity)
      ? (params.get('granularity') as Granularity)
      : (defaultState?.granularity ?? ('hour' as Granularity));

    const chartMetric = isValidMetricKey(params.get('metric') ?? '')
      ? (params.get('metric') as MetricKey)
      : (defaultState?.chartMetric ?? ('cost' as MetricKey));

    const groupByRaw = params.get('group');
    const groupBy =
      groupByRaw === 'none' || isValidDimension(groupByRaw ?? '')
        ? (groupByRaw as Dimension | 'none')
        : (defaultState?.groupBy ?? ('none' as const));

    const personalView =
      params.get('personalView') ?? defaultState?.personalView ?? 'personal-only';

    const viewAsRaw = params.get('viewAs');
    const viewAs = viewAsRaw === 'org-wide' ? 'org-wide' : (defaultState?.viewAs ?? 'self');

    const filters = deserializeFiltersFromParams(params);

    return { period, granularity, chartMetric, filters, groupBy, personalView, viewAs };
  });

  const isInitialized = useRef(false);
  const prevState = useRef<DashboardState | null>(null);
  const syncDirection = useRef<'push' | 'ignore'>('push');

  // Mark as initialized after first render
  useEffect(() => {
    isInitialized.current = true;
    prevState.current = state;
  }, []);

  // Detect browser back/forward navigation and re-sync state from URL.
  // `router.replace` triggers `popstate` on the same page; we use
  // `syncDirection` to avoid bouncing — only apply URL changes that came
  // from genuine navigation, not from our own `router.replace`.
  useEffect(() => {
    const onPopState = () => {
      syncDirection.current = 'ignore';
      const params = new URLSearchParams(window.location.search);

      const period = VALID_PERIODS.includes(params.get('period') as PeriodOption)
        ? (params.get('period') as PeriodOption)
        : state.period;
      const granularity = VALID_GRANULARITIES.includes(params.get('granularity') as Granularity)
        ? (params.get('granularity') as Granularity)
        : state.granularity;
      const chartMetric = isValidMetricKey(params.get('metric') ?? '')
        ? (params.get('metric') as MetricKey)
        : state.chartMetric;
      const groupByRaw = params.get('group');
      const groupBy =
        groupByRaw === 'none' || isValidDimension(groupByRaw ?? '')
          ? (groupByRaw as Dimension | 'none')
          : state.groupBy;
      const personalView = params.get('personalView') ?? state.personalView;
      const viewAsRaw = params.get('viewAs');
      const viewAs = viewAsRaw === 'org-wide' ? 'org-wide' : state.viewAs;
      const filters = deserializeFiltersFromParams(params);

      setStateInternal({
        period,
        granularity,
        chartMetric,
        filters,
        groupBy,
        personalView,
        viewAs,
      });

      // After the state update flushes, resume pushing to the URL.
      // One animation frame is enough for React to commit the state.
      requestAnimationFrame(() => {
        syncDirection.current = 'push';
      });
    };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [
    state.period,
    state.granularity,
    state.chartMetric,
    state.groupBy,
    state.personalView,
    state.viewAs,
  ]);

  // Sync state to URL parameters when state changes
  useEffect(() => {
    if (!isInitialized.current) return;
    if (syncDirection.current === 'ignore') return;
    if (!prevState.current) {
      prevState.current = state;
      return;
    }
    // Skip if nothing changed
    if (JSON.stringify(prevState.current) === JSON.stringify(state)) return;
    prevState.current = state;

    const params = new URLSearchParams(searchParams.toString());

    // Set simple params
    params.set('period', state.period);
    params.set('granularity', state.granularity);
    params.set('metric', state.chartMetric);
    params.set('group', state.groupBy);

    if (state.personalView && state.personalView !== 'personal-only') {
      params.set('personalView', state.personalView);
    } else {
      params.delete('personalView');
    }

    if (state.viewAs === 'org-wide') {
      params.set('viewAs', 'org-wide');
    } else {
      params.delete('viewAs');
    }

    serializeFiltersToParams(params, state.filters);

    const queryString = params.toString();
    const url = new URL(window.location.origin + window.location.pathname);
    if (queryString) url.search = queryString;

    router.replace(url.toString(), { scroll: false });
    // searchParams intentionally excluded: the effect overwrites every relevant
    // key from `state` anyway, so stale searchParams never produces incorrect
    // output and including it would cause spurious re-runs after router.replace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router, state]);

  const setState = useCallback((updates: Partial<DashboardState>) => {
    setStateInternal(prev => ({ ...prev, ...updates }));
  }, []);

  return { state, setState };
}
