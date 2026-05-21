import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';

import { CodeReviewQueueHealthSummary } from './CodeReviewQueueHealthSummary';

describe('CodeReviewQueueHealthSummary', () => {
  it('renders live queue diagnostics separately from historical telemetry controls', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeReviewQueueHealthSummary, {
        data: {
          pendingReviewCount: 12,
          pendingOverFiveMinutesCount: 4,
          oldestPendingAgeSeconds: 3661,
          staleQueuedClaimCount: 3,
          runningOverNinetyMinutesCount: 2,
          ownersWithWaitingReviewsCount: 5,
        },
      })
    );

    expect(html).toContain('Current queue health');
    expect(html).toContain('Live dispatch snapshot. Owner filters apply.');
    expect(html).toContain('Date range and retry accounting affect telemetry below only.');
    expect(html).toContain('Pending &gt; 5m');
    expect(html).toContain('Stale queued claims');
    expect(html).toContain('Running &gt; 90m');
    expect(html).toContain('1.0h');
    expect(html).toContain('Owners waiting');
  });

  it('shows a stable empty oldest-pending value when no review is pending', () => {
    const html = renderToStaticMarkup(
      React.createElement(CodeReviewQueueHealthSummary, {
        data: {
          pendingReviewCount: 0,
          pendingOverFiveMinutesCount: 0,
          oldestPendingAgeSeconds: 0,
          staleQueuedClaimCount: 0,
          runningOverNinetyMinutesCount: 0,
          ownersWithWaitingReviewsCount: 0,
        },
      })
    );

    expect(html).toContain('Oldest pending');
    expect(html).toContain('>-</div>');
    expect(html).not.toContain('stuck');
    expect(html).not.toContain('abandoned');
  });
});
