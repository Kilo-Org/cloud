import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  hasActiveSecurityFindingFilters,
  parseSecurityFindingFilters,
  toSecurityFindingQuery,
} from '@/lib/security-agent-filters';

describe('DEFAULT_SECURITY_FINDING_FILTERS', () => {
  it('opens on open findings, unfiltered otherwise, sorted by severity', () => {
    expect(DEFAULT_SECURITY_FINDING_FILTERS).toEqual({
      status: 'open',
      severity: 'all',
      outcome: 'all',
      repoFullName: null,
      sortBy: 'severity_desc',
    });
  });
});

describe('toSecurityFindingQuery', () => {
  it('maps the default filters to the server query, omitting "all" sentinels', () => {
    expect(toSecurityFindingQuery(DEFAULT_SECURITY_FINDING_FILTERS)).toEqual({
      status: 'open',
      sortBy: 'severity_desc',
      limit: 100,
      offset: 0,
    });
  });

  it('includes severity, outcomeFilter, and repoFullName when set to a real value', () => {
    expect(
      toSecurityFindingQuery({
        status: 'all',
        severity: 'critical',
        outcome: 'exploitable',
        repoFullName: 'kilocode/cloud',
        sortBy: 'sla_due_at_asc',
      })
    ).toEqual({
      severity: 'critical',
      outcomeFilter: 'exploitable',
      repoFullName: 'kilocode/cloud',
      sortBy: 'sla_due_at_asc',
      limit: 100,
      offset: 0,
    });
  });

  it('omits status when the UI sentinel "all" is selected', () => {
    const query = toSecurityFindingQuery({ ...DEFAULT_SECURITY_FINDING_FILTERS, status: 'all' });
    expect(query).not.toHaveProperty('status');
  });

  it('forwards overdue only when explicitly set', () => {
    expect(toSecurityFindingQuery(DEFAULT_SECURITY_FINDING_FILTERS)).not.toHaveProperty('overdue');
    expect(
      toSecurityFindingQuery({ ...DEFAULT_SECURITY_FINDING_FILTERS, overdue: true })
    ).toMatchObject({ overdue: true });
  });
});

describe('parseSecurityFindingFilters', () => {
  it('maps recognized route params onto filter state', () => {
    expect(
      parseSecurityFindingFilters({ status: 'closed', outcomeFilter: 'dismissed' })
    ).toMatchObject({
      status: 'closed',
      outcome: 'dismissed',
    });
  });

  it('falls back to defaults for missing params', () => {
    expect(parseSecurityFindingFilters({})).toEqual(DEFAULT_SECURITY_FINDING_FILTERS);
  });

  it('falls back to defaults for invalid/unrecognized values', () => {
    expect(
      parseSecurityFindingFilters({
        status: 'bogus',
        severity: 'ultra',
        outcomeFilter: 'nonsense',
        sortBy: 'random',
      })
    ).toEqual(DEFAULT_SECURITY_FINDING_FILTERS);
  });

  it('survives Dashboard deep-link params: repoFullName, outcomeFilter, overdue', () => {
    expect(
      parseSecurityFindingFilters({
        repoFullName: 'kilocode/cloud',
        outcomeFilter: 'exploitable',
        overdue: 'true',
      })
    ).toMatchObject({
      repoFullName: 'kilocode/cloud',
      outcome: 'exploitable',
      overdue: true,
    });
  });

  it('treats a missing overdue param as unset (not false)', () => {
    expect(parseSecurityFindingFilters({}).overdue).toBeUndefined();
  });

  it('treats any non-"true" overdue value as unset', () => {
    expect(parseSecurityFindingFilters({ overdue: 'false' }).overdue).toBeUndefined();
  });
});

describe('hasActiveSecurityFindingFilters', () => {
  it('is false for the default-open filters alone', () => {
    expect(hasActiveSecurityFindingFilters(DEFAULT_SECURITY_FINDING_FILTERS)).toBe(false);
  });

  it('is true when status differs from the default', () => {
    expect(
      hasActiveSecurityFindingFilters({ ...DEFAULT_SECURITY_FINDING_FILTERS, status: 'all' })
    ).toBe(true);
  });

  it('is true when severity, outcome, repoFullName, sortBy, or overdue is set', () => {
    expect(
      hasActiveSecurityFindingFilters({ ...DEFAULT_SECURITY_FINDING_FILTERS, severity: 'critical' })
    ).toBe(true);
    expect(
      hasActiveSecurityFindingFilters({
        ...DEFAULT_SECURITY_FINDING_FILTERS,
        outcome: 'exploitable',
      })
    ).toBe(true);
    expect(
      hasActiveSecurityFindingFilters({
        ...DEFAULT_SECURITY_FINDING_FILTERS,
        repoFullName: 'kilocode/cloud',
      })
    ).toBe(true);
    expect(
      hasActiveSecurityFindingFilters({
        ...DEFAULT_SECURITY_FINDING_FILTERS,
        sortBy: 'severity_asc',
      })
    ).toBe(true);
    expect(
      hasActiveSecurityFindingFilters({ ...DEFAULT_SECURITY_FINDING_FILTERS, overdue: true })
    ).toBe(true);
  });
});
