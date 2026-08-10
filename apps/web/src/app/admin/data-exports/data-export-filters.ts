export type DataExportHealthFilter = 'needs_attention' | 'active' | 'terminal' | 'all';
export type DataExportStatusFilter =
  | 'queued'
  | 'processing'
  | 'finalizing'
  | 'ready'
  | 'failed'
  | 'expired';
export type DataExportEmailStatusFilter = 'pending' | 'sending' | 'sent' | 'failed';

export type DataExportFilters = {
  health: DataExportHealthFilter;
  status: DataExportStatusFilter | undefined;
  emailStatus: DataExportEmailStatusFilter | undefined;
  search: string | undefined;
  page: number;
};

export const DEFAULT_HEALTH_FILTER: DataExportHealthFilter = 'needs_attention';
export const MAX_SEARCH_LENGTH = 320;

const HEALTH_FILTERS: readonly DataExportHealthFilter[] = [
  'needs_attention',
  'active',
  'terminal',
  'all',
];
const STATUS_FILTERS: readonly DataExportStatusFilter[] = [
  'queued',
  'processing',
  'finalizing',
  'ready',
  'failed',
  'expired',
];
const EMAIL_STATUS_FILTERS: readonly DataExportEmailStatusFilter[] = [
  'pending',
  'sending',
  'sent',
  'failed',
];

export function parsePage(value: string | null): number {
  const page = Number.parseInt(value ?? '', 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

export function parseHealthFilter(value: string | null): DataExportHealthFilter {
  return HEALTH_FILTERS.find(filter => filter === value) ?? DEFAULT_HEALTH_FILTER;
}

export function parseStatusFilter(value: string | null): DataExportStatusFilter | undefined {
  return STATUS_FILTERS.find(filter => filter === value);
}

export function parseEmailStatusFilter(
  value: string | null
): DataExportEmailStatusFilter | undefined {
  return EMAIL_STATUS_FILTERS.find(filter => filter === value);
}

export function parseSearch(value: string | null): string | undefined {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_SEARCH_LENGTH);
}

export function parseDataExportFilters(searchParams: URLSearchParams): DataExportFilters {
  return {
    health: parseHealthFilter(searchParams.get('health')),
    status: parseStatusFilter(searchParams.get('status')),
    emailStatus: parseEmailStatusFilter(searchParams.get('email')),
    search: parseSearch(searchParams.get('q')),
    page: parsePage(searchParams.get('page')),
  };
}

function setParam(params: URLSearchParams, key: string, value: string | undefined) {
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
}

/**
 * Applies filters to the given params, omitting values that match defaults so
 * shared URLs stay short. Unrelated params are preserved.
 */
export function applyDataExportFilters(
  base: URLSearchParams,
  filters: DataExportFilters
): URLSearchParams {
  const params = new URLSearchParams(base.toString());
  setParam(params, 'health', filters.health === DEFAULT_HEALTH_FILTER ? undefined : filters.health);
  setParam(params, 'status', filters.status);
  setParam(params, 'email', filters.emailStatus);
  setParam(params, 'q', filters.search);
  setParam(params, 'page', filters.page > 1 ? String(filters.page) : undefined);
  return params;
}
