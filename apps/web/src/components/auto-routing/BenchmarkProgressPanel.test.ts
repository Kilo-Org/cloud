import { describe, expect, it } from '@jest/globals';
import type { PaidBenchmarkCase, PaidBenchmarkProgress } from '@kilocode/auto-routing-contracts';
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BenchmarkProgressPanel } from './BenchmarkProgressPanel';

const CASE: PaidBenchmarkCase = {
  id: 'case-run-1',
  model: 'vendor/a',
  variant: 'high',
  caseId: 'case-7',
  repetition: 2,
  status: 'done',
  billedModelRequests: 3,
  kiloCoveredModelRequests: 1,
  kiloCoveredMicrodollars: 50_000,
  coveredByKilo: false,
  chargedMicrodollars: 120_000,
  reason: null,
};

type NonEmptyProgress = Exclude<PaidBenchmarkProgress, { status: 'empty' }>;
type PanelProps = ComponentProps<typeof BenchmarkProgressPanel>;

function progress(
  status: NonEmptyProgress['status'],
  reason: string | null = null,
  chargedMicrodollars = status === 'paused' ? 0 : 400_000,
  pendingModelRequests = 0
): NonEmptyProgress {
  const fields = {
    id: '00000000-0000-4000-8000-000000000002',
    estimateMicrodollars: 1_000_000,
    maximumMicrodollars: 1_200_000,
    chargedMicrodollars,
    billedModelRequests: 7,
    kiloCoveredModelRequests: 2,
    kiloCoveredMicrodollars: 90_000,
    pendingModelRequests,
    counts: { queued: 1, running: 1, reused: 2, done: 1, failed: 0, paused: 0 },
    cases: [CASE],
    nextCursor: 'cursor-2',
  };
  if (status === 'paused') {
    return { ...fields, status, reason };
  }
  if (status === 'failed') {
    return {
      ...fields,
      status,
      reason: 'A required model is permanently unavailable',
      retryable: false,
    };
  }
  return { ...fields, status };
}

function render(
  progressValue: NonEmptyProgress,
  overrides: Partial<Omit<PanelProps, 'progress'>> = {}
): string {
  return renderToStaticMarkup(
    createElement(BenchmarkProgressPanel, {
      progress: progressValue,
      cases: progressValue.cases,
      filter: 'all',
      onFilterChange: () => undefined,
      hasMore: true,
      loadingMore: false,
      onLoadMore: () => undefined,
      pausePending: false,
      error: null,
      onPause: () => undefined,
      onFreshEstimate: () => undefined,
      quotePending: false,
      onRefreshProgress: () => undefined,
      refreshPending: false,
      ...overrides,
    })
  );
}

describe('BenchmarkProgressPanel', () => {
  it('reports all six case states and the spend so far', () => {
    const html = render(progress('active'));
    const labels = ['Queued 1', 'Running 1', 'Reused (free) 2', 'Done 1', 'Failed 0', 'Paused 0'];
    for (const label of labels) {
      expect(html).toContain(label);
    }
    expect(html).toContain('Spent $0.40');
    expect(html).toContain('full-cost scenario $1.20');
    expect(html).not.toContain('review threshold');
    expect(html).not.toContain('Spend is above the estimate');
    expect(html).toContain('3 of 5 cases finished');
    expect(html).toContain('Kilo covered: 2 model requests ($0.09) once it joined');
    expect(html).toContain('Billed to this pool: 7 model requests so far');
    expect(html).not.toContain('reserved');
  });

  it('warns when native actual spend exceeds the forecast', () => {
    const html = render(progress('active', null, 1_300_000));
    expect(html).toContain('Spend is above the estimate');
    expect(html).toContain('Actual charges are $1.30');
    expect(html).toContain('over the $1.00 estimate');
    expect(html).toContain('estimate does not limit charges');
  });

  it('offers pause while a request is in flight', () => {
    const html = render(progress('active'));
    expect(html).toContain('Pause benchmark');
    expect(html).not.toContain('Get a fresh estimate');
  });

  it('gives pending feedback while a pause is in flight', () => {
    const html = render(progress('active'), { pausePending: true });
    expect(html).toContain('Pausing…');
    expect(html).toContain('then billing stops');
  });

  it('shows the pause receipt from the settled server state', () => {
    const html = render(progress('paused', null, 400_000));
    expect(html).toContain('Paused and billed');
    expect(html).toContain('You were charged $0.40');
    expect(html).toContain('model requests billed before the pause');
    expect(html).toContain('Those charges stay');
    expect(html).toContain('Kilo covered: 2 model requests ($0.09) once it joined');
    expect(html).toContain('No further cases will start');
    expect(html).toContain('Get a fresh estimate');
    expect(html).not.toContain('released');
    expect(html).not.toContain('reserved');
  });

  it('does not claim a charge when the pause happened before any billing', () => {
    const html = render(progress('paused'));
    expect(html).toContain('No model requests were billed before the pause.');
    expect(html).not.toContain('You were charged');
  });

  it('never says nothing was billed while an admitted call has no receipt', () => {
    const html = render(progress('paused', null, 0, 3));
    expect(html).not.toContain('No model requests were billed');
    expect(html).toContain('No charges are confirmed yet.');
    expect(html).toContain('3 model requests are admitted for this pool but not confirmed yet');
    expect(html).toContain('the total may change');
    expect(html).toContain('Refresh receipts');
    expect(html).not.toContain('You were charged');
  });

  it('discloses pending receipts on a completed request', () => {
    const html = render(progress('completed', null, 400_000, 1));
    expect(html).toContain('1 model request was admitted and is not confirmed yet');
    expect(html).toContain('the final total may be higher');
    expect(html).toContain('Refresh receipts');
  });

  it('names the pause reason when the payer could not continue', () => {
    const html = render(progress('paused', 'No credit remains for this pool.', 400_000));
    expect(html).toContain('No credit remains for this pool.');
    expect(html).toContain('Those charges stay');
  });

  it('names a non-retryable failure and its reason', () => {
    const html = render(progress('failed'));
    expect(html).toContain('The benchmark cannot finish');
    expect(html).toContain('A required model is permanently unavailable');
  });

  it('does not offer pause for a finished request', () => {
    const html = render(progress('completed'));
    expect(html).not.toContain('Pause benchmark');
  });

  it('lists each case with its state, model, and charge', () => {
    const html = render(progress('active'));
    expect(html).toContain('vendor/a');
    expect(html).toContain('high');
    expect(html).toContain('Case case-7');
    expect(html).toContain('$0.12 · 3 billed');
    expect(html).toContain('1 covered');
    expect(html).toContain('Load more cases');
  });
});
