import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WatchPrMaintenanceHistoryEntry } from '@/lib/cloud-agent/watch-pr-maintenance-history';
import { PrMaintenanceHistory } from './PrMaintenanceHistory';

Object.assign(globalThis, { React });

it('renders only HTTP(S) verification evidence from the compact history DTO', () => {
  const entry: WatchPrMaintenanceHistoryEntry = {
    id: 'attempt-example',
    ordinal: 1,
    status: 'completed',
    session_id: null,
    cloud_agent_session_id: null,
    created_at: '2026-11-12T12:00:00.000Z',
    updated_at: '2026-11-12T12:00:00.000Z',
    reason: null,
    chatAvailable: false,
    total_cost_microdollars: null,
    triggerCount: 2,
    triggers: [{ problemKey: 'review-example', kind: 'review', label: 'Check the input boundary' }],
    result: {
      summary: 'Inspected the boundary',
      changedFileCount: 2,
      verificationCount: 3,
      changedFiles: [],
      needsInput: null,
      publication: { status: 'not_attempted', reason: 'No changes needed' },
      verification: [
        {
          command: 'pnpm test',
          outcome: 'passed',
          summary: 'Focused check passed',
          evidenceUrls: [
            'https://ci.example.com/run/123',
            'http://localhost:3000/proof',
            'javascript:alert(1)',
            'data:text/html,untrusted',
            'file:///tmp/proof',
          ],
        },
      ],
    },
  };
  const html = renderToStaticMarkup(createElement(PrMaintenanceHistory, { history: [entry] }));
  expect(html).toContain('href="https://ci.example.com/run/123"');
  expect(html).toContain('href="http://localhost:3000/proof"');
  expect(html).not.toMatch(/javascript:|data:text|file:\/\/\/|alert\(1\)/);
  expect(html).toContain('Review feedback: Check the input boundary');
  expect(html).toContain('Focused check passed');
  expect(html).toContain('Showing 1 of 2 triggers.');
  expect(html).toContain('2 changed files (0 shown)');
  expect(html).toContain('Showing 1 of 3 verification results.');
});
