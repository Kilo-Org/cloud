import { describe, expect, it } from '@jest/globals';
import type { PaidBenchmarkQuote } from '@kilocode/auto-routing-contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BenchmarkQuotePanel } from './BenchmarkQuotePanel';
import type { BenchmarkFailureCopy } from './benchmark-display';

const READY_QUOTE: PaidBenchmarkQuote = {
  status: 'ready',
  id: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2026-11-20T13:00:00.000Z',
  estimateMicrodollars: 1_234_000,
  maximumMicrodollars: 1_500_000,
  cases: { reused: 4, covered: 2, shared: 3, exclusive: 1 },
  aliases: [{ model: '~vendor/model-latest', target: 'vendor/model-2' }],
};

function render(quote: PaidBenchmarkQuote, failure: BenchmarkFailureCopy | null = null): string {
  return renderToStaticMarkup(
    createElement(BenchmarkQuotePanel, {
      quote,
      failure,
      startPending: false,
      refreshPending: false,
      onStart: () => undefined,
      onRefreshQuote: () => undefined,
    })
  );
}

describe('BenchmarkQuotePanel', () => {
  it('shows the estimate, the advisory full-cost scenario, and every cost bucket', () => {
    const html = render(READY_QUOTE);
    expect(html).toContain('$1.23');
    expect(html).toContain('full-cost scenario $1.50 for the slots this pool would pay');
    expect(html).toContain('This estimate is not a limit');
    expect(html).toContain('If no payer can pay, the case pauses');
    expect(html).toContain('Charges can exceed the estimate');
    expect(html).toContain('10 case runs');
    expect(html).toContain('Reused results');
    expect(html).toContain('Covered by Kilo');
    expect(html).toContain('Shared with other pools');
    expect(html).toContain('Only this pool');
    expect(html).toContain('take turns paying');
    expect(html).toContain('Kilo joins a case, Kilo pays the model requests from then on');
    expect(html).not.toContain('approved maximum');
    expect(html).not.toContain('quote ceiling');
    expect(html).not.toContain('never more than');
    expect(html).not.toContain('review threshold');
    expect(html).not.toContain('stops admitting');
  });

  it('names each alias target the estimate pins', () => {
    const html = render(READY_QUOTE);
    expect(html).toContain('~vendor/model-latest');
    expect(html).toContain('vendor/model-2');
  });

  it('offers the explicit start and says nothing runs before it', () => {
    const html = render(READY_QUOTE);
    expect(html).toContain('Start benchmark · estimated $1.23');
    expect(html).toContain('Nothing runs until you start it.');
  });

  it('keeps start available after a retryable failure', () => {
    const html = render(READY_QUOTE, {
      title: 'Could not reach the benchmark service',
      description: 'Check your connection and try again. Nothing was charged.',
      retryable: true,
    });
    expect(html).toContain('Start benchmark');
    expect(html).not.toContain('Get a new estimate');
  });

  it('replaces start with a fresh estimate after an unaffordable quote', () => {
    const html = render(READY_QUOTE, {
      title: 'Not enough credits',
      description: 'It needs $2.50 and your balance is $0.30. Add credits.',
      retryable: false,
    });
    expect(html).toContain('Not enough credits');
    expect(html).toContain('Get a new estimate');
  });

  it('explains an empty pool instead of offering a start', () => {
    const html = render({ status: 'empty' });
    expect(html).toContain('Nothing to benchmark');
    expect(html).toContain('Get a fresh estimate');
    expect(html).not.toContain('Start benchmark');
  });
});
