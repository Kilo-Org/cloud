// Audit-report screen body contract: a transient failure keeps the cached
// report with an inline retry; a denial never keeps it; and the screen picks
// the personal or org tRPC procedure from its scope (mirroring
// use-security-agent.ts).

import { beforeEach, describe, expect, it } from 'vitest';

import {
  findByType,
  makeReport,
  orgQueryOptions,
  personalQueryOptions,
  renderScreen,
  resetQueryMocks,
  setQueryState,
  useQueryEnabledFlags,
} from './audit-report-screen.test-helpers';

describe('AuditReportScreen cached report', () => {
  beforeEach(resetQueryMocks);

  it('retains a cached report with an inline retry after a transient failure', () => {
    setQueryState({
      isError: true,
      error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
      data: { status: 'ok', report: makeReport() },
    });
    const tree = renderScreen('personal');
    expect(findByType(tree.root, 'CollapsibleSection')).toHaveLength(1);
    expect(findByType(tree.root, 'QueryError')[0]?.props.placement).toBe('top');
    expect(findByType(tree.root, 'TabScreenScrollView')).toHaveLength(1);
  });

  it('shows a full-body failure when the cached report has no activity', () => {
    setQueryState({
      isError: true,
      data: { status: 'ok', report: makeReport({ findings: [] }) },
    });
    const tree = renderScreen('personal');
    expect(findByType(tree.root, 'QueryError')).toHaveLength(1);
    expect(findByType(tree.root, 'QueryError')[0]?.props.placement).not.toBe('top');
    expect(findByType(tree.root, 'TabScreenScrollView')).toHaveLength(0);
    expect(findByType(tree.root, 'EmptyState')).toHaveLength(0);
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('does not retain a report after %s', code => {
    setQueryState({
      isError: true,
      error: { data: { code } },
      data: { status: 'ok', report: makeReport() },
    });
    const tree = renderScreen('org-123');
    expect(findByType(tree.root, 'CollapsibleSection')).toHaveLength(0);
    expect(findByType(tree.root, 'EmptyState')).toHaveLength(1);
  });

  it('renders one section per finding group for a non-empty report', () => {
    setQueryState({ data: { status: 'ok', report: makeReport() } });
    const root = renderScreen('personal');

    expect(findByType(root.root, 'CollapsibleSection')).toHaveLength(1);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
  });
});

describe('AuditReportScreen personal/org branching', () => {
  beforeEach(resetQueryMocks);

  it('calls the personal procedure (enabled) for the personal scope', () => {
    setQueryState({ isLoading: true });
    renderScreen('personal');

    expect(personalQueryOptions).toHaveBeenCalledWith({});
    expect(orgQueryOptions).toHaveBeenCalledWith({ organizationId: 'personal' });
    expect(useQueryEnabledFlags()).toEqual([true, false]);
  });

  it('calls the org procedure (enabled) for an organization scope', () => {
    setQueryState({ isLoading: true });
    renderScreen('org-123');

    expect(personalQueryOptions).toHaveBeenCalledWith({});
    expect(orgQueryOptions).toHaveBeenCalledWith({ organizationId: 'org-123' });
    expect(useQueryEnabledFlags()).toEqual([false, true]);
  });
});
