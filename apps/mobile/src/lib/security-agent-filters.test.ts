import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SECURITY_FINDING_FILTERS,
  getNextSecurityFindingsOffset,
  hasActiveSecurityFindingFilters,
  parseSecurityFindingFilters,
  selectSecurityFindingOutcome,
  selectSecurityFindingStatus,
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
      limit: 50,
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
      limit: 50,
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

  it('omits status when the selected outcome already implies a terminal status', () => {
    expect(
      toSecurityFindingQuery({ ...DEFAULT_SECURITY_FINDING_FILTERS, outcome: 'fixed' })
    ).not.toHaveProperty('status');
    expect(
      toSecurityFindingQuery({ ...DEFAULT_SECURITY_FINDING_FILTERS, outcome: 'dismissed' })
    ).not.toHaveProperty('status');
  });
});

describe('parseSecurityFindingFilters', () => {
  it('drops a conflicting status when a route selects a terminal outcome', () => {
    expect(
      parseSecurityFindingFilters({ status: 'closed', outcomeFilter: 'dismissed' })
    ).toMatchObject({
      status: 'all',
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

describe('filter selection', () => {
  it('clears a terminal outcome when a concrete status is selected', () => {
    expect(
      selectSecurityFindingStatus(
        { ...DEFAULT_SECURITY_FINDING_FILTERS, status: 'all', outcome: 'dismissed' },
        'closed'
      )
    ).toMatchObject({ status: 'closed', outcome: 'all' });
  });

  it('clears status when a terminal outcome is selected', () => {
    expect(selectSecurityFindingOutcome(DEFAULT_SECURITY_FINDING_FILTERS, 'fixed')).toMatchObject({
      status: 'all',
      outcome: 'fixed',
    });
  });

  it('preserves status for outcomes that do not imply one', () => {
    expect(
      selectSecurityFindingOutcome(DEFAULT_SECURITY_FINDING_FILTERS, 'exploitable')
    ).toMatchObject({ status: 'open', outcome: 'exploitable' });
  });
});

describe('getNextSecurityFindingsOffset', () => {
  it('returns the next absolute offset when more findings remain', () => {
    expect(getNextSecurityFindingsOffset(20, 50, 100)).toBe(70);
  });

  it('stops after loading all findings remaining after a non-zero offset', () => {
    expect(getNextSecurityFindingsOffset(20, 80, 100)).toBeUndefined();
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
