// Audit-report screen state contract: loading shows a skeleton; a network
// error and a `query_failed` response are retryable (inline error + Retry);
// the org billing-gate denial (FORBIDDEN/UNAUTHORIZED) is non-retryable with
// an explanation and no Retry; an empty period shows EmptyState.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  findByType,
  firstChildTypeOfScreenRoot,
  makeReport,
  renderScreen,
  resetQueryMocks,
  setQueryState,
} from './audit-report-screen.test-helpers';

describe('AuditReportScreen states', () => {
  beforeEach(resetQueryMocks);

  it('renders the ScreenHeader as the first child', () => {
    setQueryState({ isLoading: true });
    const root = renderScreen('personal');

    expect(firstChildTypeOfScreenRoot(root.root)).toBe('ScreenHeader');
  });

  it('renders a skeleton while loading', () => {
    setQueryState({ isLoading: true });
    const root = renderScreen('personal');

    expect(findByType(root.root, 'Skeleton').length).toBeGreaterThan(0);
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders a retryable error with Retry on a network failure', () => {
    setQueryState({ isError: true, error: { data: { code: 'INTERNAL_SERVER_ERROR' } } });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Could not load the audit report');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
  });

  it('maps query_failed to a retryable error, not empty', () => {
    setQueryState({
      data: { status: 'query_failed', message: 'Report query did not finish' },
    });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Report query did not finish. Try again.');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it('renders a retryable offline error on a paused initial fetch', () => {
    setQueryState({ isPending: true, isPaused: true });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('offline');
    expect(errors[0]?.props.message).toBe('Check your connection and try again.');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'Skeleton')).toHaveLength(0);
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'])('renders a non-retryable explanation for %s', code => {
    setQueryState({ isError: true, error: { data: { code } } });
    const root = renderScreen('org-123');

    const empty = findByType(root.root, 'EmptyState');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.title).toBe('Audit report unavailable');
    expect(findByType(root.root, 'QueryError')).toHaveLength(0);
    // The screen owns the scroll container and asks EmptyState for its plain
    // content, so the denial message paints instead of a lone icon (finding 3).
    expect(empty[0]?.props.placement).toBe('static');
    expect(findByType(root.root, 'TabScreenScrollView')).toHaveLength(1);
  });

  it('treats a personal UNAUTHORIZED as a retryable session error', () => {
    setQueryState({ isError: true, error: { data: { code: 'UNAUTHORIZED' } } });
    const root = renderScreen('personal');

    const errors = findByType(root.root, 'QueryError');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.message).toBe('Could not load the audit report');
    expect(typeof errors[0]?.props.onRetry).toBe('function');
    expect(findByType(root.root, 'EmptyState')).toHaveLength(0);
  });

  // Explorer security-audit finding 3: CenteredState's measured path painted
  // the icon bubble but collapsed the copy, so the audit report's empty states
  // own a TabScreenScrollView (`grow justify-center`) and reach EmptyState with
  // `placement="static"`, which renders the title and description directly.
  it('renders EmptyState for an empty period', () => {
    setQueryState({
      data: {
        status: 'ok',
        report: makeReport({ findings: [], summary: { findingCount: 0, activityCount: 0 } }),
      },
    });
    const root = renderScreen('personal');

    const empty = findByType(root.root, 'EmptyState');
    expect(empty).toHaveLength(1);
    expect(empty[0]?.props.title).toBe('No recorded activity');
    expect(empty[0]?.props.placement).toBe('static');
    // The owner line the centered state used to carry is the header's subtitle.
    expect(findByType(root.root, 'ScreenHeader')[0]?.props.subtitle).toBe('Personal owner');
    expect(findByType(root.root, 'TabScreenScrollView')).toHaveLength(1);
  });
});
