import { describe, expect, it } from '@jest/globals';
import type { BenchmarkRegistryFailedEntry } from '@kilocode/auto-routing-contracts';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FailedModelsTable } from './FailedModelsTable';

const now = new Date('2026-11-20T12:00:00.000Z');

const permanent: BenchmarkRegistryFailedEntry = {
  model: 'vendor/absent',
  variant: 'high',
  queues: ['platform', 'user'],
  runId: null,
  failure: {
    kind: 'permanent',
    failureClass: 'catalog_absent',
    reason: 'Model or variant is unavailable in the executable benchmark catalog.',
    attempts: 1,
    firstFailedAt: '2026-11-19T22:59:00.000Z',
    lastFailedAt: '2026-11-19T22:59:00.000Z',
    cause: 'terminal_class',
  },
};

function retryable(retryAfter: string): BenchmarkRegistryFailedEntry {
  return {
    model: 'vendor/flaky',
    variant: null,
    queues: ['user'],
    runId: 'user-run-1',
    failure: {
      kind: 'retryable',
      failureClass: 'provider_unavailable',
      reason: null,
      attempts: 2,
      firstFailedAt: '2026-11-19T10:00:00.000Z',
      lastFailedAt: '2026-11-20T10:00:00.000Z',
      retryAfter,
    },
  };
}

function render(entries: BenchmarkRegistryFailedEntry[], readmittingKey: string | null = null) {
  return renderToStaticMarkup(
    React.createElement(FailedModelsTable, {
      entries,
      now,
      readmittingKey,
      onReadmit: () => {},
    })
  );
}

describe('failed models table', () => {
  it('shows the empty state when nothing failed', () => {
    expect(render([])).toContain('No failed models');
  });

  it('tells permanent from retryable rows and when each can run again', () => {
    const html = render([permanent, retryable('2026-11-20T11:00:00.000Z')]);
    expect(html).toContain('Permanent');
    expect(html).toContain('catalog_absent');
    expect(html).toContain('Platform, User');
    expect(html).toContain('Re-admit only');
    expect(html).toContain('Retryable');
    expect(html).toContain('provider_unavailable');
    expect(html).toContain('No reason recorded');
    expect(html).toContain('1 attempt<');
    expect(html).toContain('2 attempts<');
    expect(html).toContain(
      'title="Model or variant is unavailable in the executable benchmark catalog."'
    );
    expect(html).toContain('Eligible now');
    expect(html).toContain('aria-label="Re-admit vendor/absent high"');
    expect(html).toContain('aria-label="Re-admit vendor/flaky default"');
  });

  it('shows a future retry window instead of eligibility', () => {
    const html = render([retryable('2026-11-20T14:00:00.000Z')]);
    expect(html).not.toContain('Eligible now');
    expect(html).toContain(
      new Date('2026-11-20T14:00:00.000Z').toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    );
  });

  it('marks the row being re-admitted and disables every re-admit', () => {
    const html = render(
      [permanent, retryable('2026-11-20T11:00:00.000Z')],
      JSON.stringify(['vendor/absent', 'high'])
    );
    expect(html).toContain('Re-admitting');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
