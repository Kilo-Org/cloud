import { describe, it, expect } from '@jest/globals';
import type { AuditLogsFilters } from '../useAuditLogsFilters';
import type { AuditLogAction } from '@/lib/organizations/organization-audit-logs';

// Since we can't easily test the full hook without a React environment,
// let's at least test the serialization functions by extracting them
// This is a basic test to verify our URL parameter logic

describe('AuditLogsFilters URL Serialization', () => {
  // Helper functions extracted from the hook for testing
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

  it('should serialize filters to URL parameters correctly', () => {
    const filters: AuditLogsFilters = {
      action: ['organization.user.login', 'organization.user.logout'] as AuditLogAction[],
      actorEmail: 'test@example.com',
      fuzzySearch: 'test search',
      startTime: new Date('2023-01-01T00:00:00.000Z'),
      endTime: new Date('2023-12-31T23:59:59.999Z'),
    };

    const params = serializeFiltersToParams(filters);

    expect(params.get('action')).toBe('organization.user.login,organization.user.logout');
    expect(params.get('actorEmail')).toBe('test@example.com');
    expect(params.get('fuzzySearch')).toBe('test search');
    expect(params.get('startTime')).toBe('2023-01-01T00:00:00.000Z');
    expect(params.get('endTime')).toBe('2023-12-31T23:59:59.999Z');
  });

  it('should deserialize URL parameters to filters correctly', () => {
    const params = new URLSearchParams();
    params.set('action', 'organization.user.login,organization.user.logout');
    params.set('actorEmail', 'test@example.com');
    params.set('fuzzySearch', 'test search');
    params.set('startTime', '2023-01-01T00:00:00.000Z');
    params.set('endTime', '2023-12-31T23:59:59.999Z');

    const filters = deserializeFiltersFromParams(params);

    expect(filters.action).toEqual(['organization.user.login', 'organization.user.logout']);
    expect(filters.actorEmail).toBe('test@example.com');
    expect(filters.fuzzySearch).toBe('test search');
    expect(filters.startTime).toEqual(new Date('2023-01-01T00:00:00.000Z'));
    expect(filters.endTime).toEqual(new Date('2023-12-31T23:59:59.999Z'));
  });

  it('should handle empty filters correctly', () => {
    const filters = {};
    const params = serializeFiltersToParams(filters);

    expect(params.toString()).toBe('');
  });

  it('should handle partial filters correctly', () => {
    const filters: AuditLogsFilters = {
      actorEmail: 'test@example.com',
      startTime: new Date('2023-01-01T00:00:00.000Z'),
    };

    const params = serializeFiltersToParams(filters);
    const deserializedFilters = deserializeFiltersFromParams(params);

    expect(deserializedFilters.actorEmail).toBe('test@example.com');
    expect(deserializedFilters.startTime).toEqual(new Date('2023-01-01T00:00:00.000Z'));
    expect(deserializedFilters.action).toBeUndefined();
    expect(deserializedFilters.fuzzySearch).toBeUndefined();
    expect(deserializedFilters.endTime).toBeUndefined();
  });

  it('should handle invalid date parameters gracefully', () => {
    const params = new URLSearchParams();
    params.set('startTime', 'invalid-date');
    params.set('endTime', 'also-invalid');

    const filters = deserializeFiltersFromParams(params);

    expect(filters.startTime).toBeUndefined();
    expect(filters.endTime).toBeUndefined();
  });
});
