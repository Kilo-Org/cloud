import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';
import type { AutoRoutingClassifierAnalyticsResponse } from '@kilocode/auto-routing-contracts';
import { AutoRoutingBreakdownTables } from './AutoRoutingAdminContent';

const analytics: AutoRoutingClassifierAnalyticsResponse = {
  period: '24h',
  summary: {
    totalRequests: 10,
    classifiedRequests: 8,
    classifierErrors: 1,
    invalidRequests: 1,
    totalCostCredits: 0.0000123,
    avgDurationMs: 123.4,
    p95DurationMs: 456.7,
    avgConfidence: 0.82,
    withSessionId: 9,
    uniqueSessions: 7,
    requiresTools: 5,
    mirroredHasTools: 6,
    avgBodyBytes: 2048,
  },
  statusBreakdown: [{ status: 'classified', requests: 8 }],
  taskTypeBreakdown: [{ taskType: 'implementation', requests: 5, avgConfidence: 0.9 }],
  taskSubtypeBreakdown: [
    {
      taskType: 'implementation',
      subtaskType: 'feature_development',
      requests: 4,
      avgConfidence: 0.88,
    },
  ],
  classifierModelBreakdown: [{ classifierModel: 'google/gemini-2.5-flash-lite', requests: 10 }],
};

describe('AutoRoutingBreakdownTables', () => {
  it('renders task type tables in a separate row after status and model tables', () => {
    const html = renderToStaticMarkup(
      React.createElement(AutoRoutingBreakdownTables, {
        analytics,
        loading: false,
      })
    );

    const statusIndex = html.indexOf('Status');
    const modelIndex = html.indexOf('Classifier Models');
    const taskTypeIndex = html.indexOf('Task Types');
    const taskSubtypeIndex = html.indexOf('Task Subtypes');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(modelIndex).toBeGreaterThan(statusIndex);
    expect(taskTypeIndex).toBeGreaterThan(modelIndex);
    expect(taskSubtypeIndex).toBeGreaterThan(taskTypeIndex);
  });
});
