import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, jest } from '@jest/globals';

import {
  SessionContainerTelemetryContent,
  type SessionContainerInfo,
} from './SessionContainerTelemetry';

const info: SessionContainerInfo = {
  cloudAgentSessionId: 'agent_1',
  sandboxId: 'ses-1',
  scope: 'isolated',
  windowStartAt: '2026-07-31T08:43:00.000Z',
  windowEndAt: '2026-07-31T08:51:00.000Z',
  runs: [],
  intervals: [
    {
      id: 'interval-1',
      service: 'cloud-agent-next-sandbox-small-containment',
      sandboxId: 'ses-1',
      cloudflareInstanceId: 'durable-object-id',
      containerClass: 'SandboxSmallContainment',
      startedAt: '2026-07-31T08:43:00.000Z',
      lastSeenAt: '2026-07-31T08:51:00.000Z',
      stoppedAt: '2026-07-31T08:51:00.000Z',
      status: 'closed',
      closeReason: 'exit',
      exitCode: 0,
      sku: { id: 'cloud-agent-small-2026-07', name: 'Cloud Agent Small', description: null },
      capacity: { vcpu: 2, memoryBytes: 6 * 1024 ** 3, diskBytes: 10_000_000_000 },
      capacitySource: 'recorded',
    },
  ],
};

describe('SessionContainerTelemetry', () => {
  it('renders workload summaries with normalized CPU utilization', () => {
    const metricsQuery = {
      isLoading: false,
      isError: false,
      data: {
        available: true as const,
        partial: false,
        issues: [],
        rows: [
          {
            windowKey: 'interval-1',
            timestamp: '2026-07-31T08:49:00.000Z',
            applicationId: 'app-1',
            instanceId: 'durable-object-id',
            placementId: 'placement-1',
            location: 'ord02',
            region: 'WNAM',
            avg: {
              cpuUtilization: 0.72,
              memory: 4 * 1024 ** 3,
              rxBandwidthBps: 10,
              txBandwidthBps: 20,
              containerUptime: 300,
            },
            max: { memory: 5 * 1024 ** 3, diskUsage: 100, diskUsagePercentage: 1 },
            quantiles: { cpuUtilizationP95: 0.9, memoryP95: 4.8 * 1024 ** 3 },
            sum: { cpuTimeSec: 30, rxBytes: 100, txBytes: 200 },
          },
        ],
      },
    };

    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const html = renderToStaticMarkup(
      React.createElement(SessionContainerTelemetryContent, { info, metricsQuery })
    );
    consoleWarn.mockRestore();

    expect(html).toContain('Peak memory');
    expect(html).toContain('5.0 GiB / 6.0 GiB');
    expect(html).toContain('90.0%');
    expect(html).not.toContain('CPU capacity');
  });
});
