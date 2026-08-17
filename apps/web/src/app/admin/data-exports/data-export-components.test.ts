import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import type { DataExportListRow } from './data-export-types';
import { DataExportsSummaryStrip } from './DataExportsSummaryStrip';
import { DataExportsTable } from './DataExportsTable';
import { formatAge, formatBytes, humanizeToken } from './data-export-format';

const summaryFixture = {
  asOf: '2026-08-09T12:00:00.000Z',
  active: 7,
  needsAttention: 3,
  staleLeases: 2,
  pendingDispatches: 5,
  failed: 1,
  cleanupDue: 4,
  emailUnhealthy: 2,
  oldestPendingAt: '2026-08-09T11:45:00.000Z',
};

const healthyRow: DataExportListRow = {
  id: '2c4f8a10-1111-4222-8333-444455556666',
  user: { id: 'user-1', email: 'ready@example.com', name: 'Ready User' },
  status: 'ready',
  schemaVersion: 1,
  currentSource: null,
  nextPartNumber: 4,
  dispatchGeneration: 1,
  attemptCount: 1,
  rowCount: 1523,
  sizeBytes: 2 * 1024 * 1024,
  requestedAt: '2026-08-09T10:00:00.000Z',
  startedAt: '2026-08-09T10:00:05.000Z',
  completedAt: '2026-08-09T10:01:00.000Z',
  expiresAt: '2026-08-16T10:01:00.000Z',
  updatedAt: '2026-08-09T10:01:00.000Z',
  leaseExpiresAt: null,
  failureCode: null,
  failureMessage: null,
  emailStatus: 'sent',
  emailAttemptCount: 1,
  health: {
    severity: 'ok',
    execution: 'ready',
    dispatch: 'not_applicable',
    email: 'sent',
    reasons: [],
    automaticWork: {
      workerClaim: false,
      reconcileToQueued: false,
      reconcileToFailed: false,
      dispatchCurrentOutbox: false,
      expireReadyObject: false,
      abortFailedMultipart: false,
      sendOrReclaimEmail: false,
      downloadAvailable: true,
    },
  },
};

const degradedRow: DataExportListRow = {
  ...healthyRow,
  id: '9d8c7b6a-5555-4666-8777-888899990000',
  user: { id: 'user-2', email: 'stuck@example.com', name: null },
  status: 'processing',
  currentSource: 'kilocode_users',
  attemptCount: 2,
  completedAt: null,
  expiresAt: null,
  emailStatus: 'pending',
  emailAttemptCount: 0,
  health: {
    severity: 'degraded',
    execution: 'lease_recovery_due',
    dispatch: 'backoff',
    email: 'not_applicable',
    reasons: ['lease_recovery_due', 'outbox_dispatch_retry'],
    automaticWork: {
      workerClaim: true,
      reconcileToQueued: true,
      reconcileToFailed: false,
      dispatchCurrentOutbox: false,
      expireReadyObject: false,
      abortFailedMultipart: false,
      sendOrReclaimEmail: false,
      downloadAvailable: false,
    },
  },
};

describe('DataExportsSummaryStrip', () => {
  it('renders all six workload metrics with counts and hints', () => {
    const html = renderToStaticMarkup(
      React.createElement(DataExportsSummaryStrip, {
        summary: summaryFixture,
        isLoading: false,
      })
    );

    expect(html).toContain('Needs attention');
    expect(html).toContain('Active exports');
    expect(html).toContain('Pending dispatches');
    expect(html).toContain('Stale leases');
    expect(html).toContain('Cleanup due');
    expect(html).toContain('Email unhealthy');
    expect(html).toContain('Oldest waiting 15m ago');
  });

  it('renders skeleton placeholders while loading without data', () => {
    const html = renderToStaticMarkup(
      React.createElement(DataExportsSummaryStrip, {
        summary: undefined,
        isLoading: true,
      })
    );

    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('Needs attention');
  });
});

describe('DataExportsTable', () => {
  it('renders rows with health, status, user, and one-shot execution details', () => {
    const html = renderToStaticMarkup(
      React.createElement(DataExportsTable, {
        rows: [healthyRow, degradedRow],
        asOf: summaryFixture.asOf,
        isLoading: false,
      })
    );

    // Links and navigation targets
    expect(html).toContain('href="/admin/users/user-1"');
    expect(html).toContain('href="/admin/data-exports/2c4f8a10-1111-4222-8333-444455556666"');

    // Health badges use text, not color alone
    expect(html).toContain('OK');
    expect(html).toContain('Degraded');
    expect(html).toContain('Lease recovery due');
    expect(html).toContain('2 reasons');

    // Status and email badges
    expect(html).toContain('Ready');
    expect(html).toContain('Processing');
    expect(html).toContain('Sent');

    // One-shot and legacy execution state
    expect(html).toContain('One-shot export');
    expect(html).toContain('Legacy generator state');
    expect(html).toContain('Generation 1');
    expect(html).toContain('2.0 MB');
    expect(html).toContain('1,523 rows');
  });

  it('renders a meaningful empty state when no rows match', () => {
    const html = renderToStaticMarkup(
      React.createElement(DataExportsTable, {
        rows: [],
        asOf: summaryFixture.asOf,
        isLoading: false,
      })
    );

    expect(html).toContain('No exports match these filters');
    expect(html).toContain('clear the search');
  });

  it('bounds long user values while preserving the full text in titles', () => {
    const longEmail = `${'long-user-'.repeat(10)}@example.com`;
    const longName = 'Very long operator-visible user name '.repeat(4);
    const html = renderToStaticMarkup(
      React.createElement(DataExportsTable, {
        rows: [
          {
            ...healthyRow,
            user: { ...healthyRow.user, email: longEmail, name: longName },
          },
        ],
        asOf: summaryFixture.asOf,
        isLoading: false,
      })
    );

    expect(html).toContain('w-56 max-w-56');
    expect(html).toContain(`title="${longEmail}"`);
    expect(html).toContain(`title="${longName}"`);
    expect(html).toContain('truncate');
  });

  it('renders skeleton rows while loading without rows', () => {
    const html = renderToStaticMarkup(
      React.createElement(DataExportsTable, {
        rows: [],
        asOf: undefined,
        isLoading: true,
      })
    );

    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('No exports match these filters');
  });
});

describe('format helpers', () => {
  it('formats deterministic ages between two timestamps', () => {
    expect(formatAge('2026-08-09T11:59:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('1m ago');
    expect(formatAge('2026-08-09T10:00:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('2h ago');
    expect(formatAge('2026-08-07T12:00:00.000Z', '2026-08-09T12:00:00.000Z')).toBe('2d ago');
  });

  it('formats byte sizes', () => {
    expect(formatBytes(null)).toBe('Not available');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });

  it('humanizes snake_case tokens', () => {
    expect(humanizeToken('lease_recovery_due')).toBe('Lease recovery due');
    expect(humanizeToken('ready')).toBe('Ready');
  });
});
