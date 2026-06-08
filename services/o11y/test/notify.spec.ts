import { describe, it, expect } from 'vitest';
import {
  buildSlackMessage,
  type SloAlertPayload,
  type ContainerCapacityAlertPayload,
  type QueueBacklogAlertPayload,
} from '../src/alerting/notify';

describe('buildSlackMessage — SLO error_rate alert', () => {
  const alert: SloAlertPayload = {
    alertType: 'error_rate',
    severity: 'page',
    provider: 'openai',
    model: 'gpt-4',
    clientName: 'kilo-gateway',
    burnRate: 14.5,
    burnRateThreshold: 14.4,
    windowMinutes: 5,
    totalRequests: 10000,
    slo: 0.999,
    currentRate: 0.0145,
  };

  it('includes PAGE severity label in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('PAGE');
  });

  it('includes Error Rate in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('Error Rate');
  });

  it('includes provider and model fields', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ fields?: Array<{ text: string }> }> };
    const sectionBlock = msg.blocks[1];
    const fieldTexts = sectionBlock.fields?.map(f => f.text) ?? [];
    expect(fieldTexts.some(t => t.includes('openai'))).toBe(true);
    expect(fieldTexts.some(t => t.includes('gpt-4'))).toBe(true);
  });
});

describe('buildSlackMessage — SLO ttfb alert', () => {
  const alert: SloAlertPayload = {
    alertType: 'ttfb',
    severity: 'ticket',
    provider: 'anthropic',
    model: 'claude-3',
    clientName: 'kilo-gateway',
    burnRate: 1.2,
    burnRateThreshold: 1.0,
    windowMinutes: 360,
    totalRequests: 5000,
    slo: 0.95,
    currentTtfbFraction: 0.08,
    ttfbThresholdMs: 2000,
  };

  it('includes TTFB Latency in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('TTFB Latency');
  });

  it('includes TICKET severity label in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('TICKET');
  });
});

describe('buildSlackMessage — queue_backlog alert', () => {
  const alert: QueueBacklogAlertPayload = {
    alertType: 'queue_backlog',
    severity: 'page',
    provider: 'cloudflare',
    model: '965459cfc1a349c190bb813855a65b02',
    clientName: 'queues',
    backlogCount: 50_000,
    backlogBytes: 12_345_678,
    thresholdCount: 50_000,
    oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
  };

  it('includes queue backlog details and oldest-message timestamp', () => {
    const msg = buildSlackMessage(alert) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(block => [
      block.text?.text ?? '',
      ...(block.fields?.map(field => field.text) ?? []),
    ]);

    expect(allText.some(text => text.includes('Queue Backlog'))).toBe(true);
    expect(allText.some(text => text.includes('50,000'))).toBe(true);
    expect(allText.some(text => text.includes('12,345,678'))).toBe(true);
    expect(allText.some(text => text.includes('2026-06-04T08:00:00.000Z'))).toBe(true);
  });
});

describe('buildSlackMessage — container_capacity alert', () => {
  const alert: ContainerCapacityAlertPayload = {
    alertType: 'container_capacity',
    severity: 'page',
    provider: 'cloudflare',
    model: 'cloud-agent-next-sandbox',
    clientName: 'containers',
    usedInstances: 241,
    maxInstances: 250,
    utilizationFraction: 0.964,
    thresholdFraction: 0.95,
  };

  it('includes PAGE severity label in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('PAGE');
  });

  it('includes Container Capacity in header', () => {
    const msg = buildSlackMessage(alert) as { blocks: Array<{ text?: { text: string } }> };
    expect(msg.blocks[0].text?.text).toContain('Container Capacity');
  });

  it('includes application name', () => {
    const msg = buildSlackMessage(alert) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(b => [
      b.text?.text ?? '',
      ...(b.fields?.map(f => f.text) ?? []),
    ]);
    expect(allText.some(t => t.includes('cloud-agent-next-sandbox'))).toBe(true);
  });

  it('includes used/max instances', () => {
    const msg = buildSlackMessage(alert) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(b => [
      b.text?.text ?? '',
      ...(b.fields?.map(f => f.text) ?? []),
    ]);
    expect(allText.some(t => t.includes('241') && t.includes('250'))).toBe(true);
  });

  it('includes utilization percentage', () => {
    const msg = buildSlackMessage(alert) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(b => [
      b.text?.text ?? '',
      ...(b.fields?.map(f => f.text) ?? []),
    ]);
    // 96.4% utilization
    expect(allText.some(t => t.includes('96.4'))).toBe(true);
  });

  it('includes threshold percentage', () => {
    const msg = buildSlackMessage(alert) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(b => [
      b.text?.text ?? '',
      ...(b.fields?.map(f => f.text) ?? []),
    ]);
    // 95.0% threshold
    expect(allText.some(t => t.includes('95.0'))).toBe(true);
  });

  it('includes health breakdown when available', () => {
    const alertWithHealth: ContainerCapacityAlertPayload = {
      ...alert,
      health: { active: 230, healthy: 5, starting: 6 },
    };
    const msg = buildSlackMessage(alertWithHealth) as {
      blocks: Array<{ fields?: Array<{ text: string }>; text?: { text: string } }>;
    };
    const allText = msg.blocks.flatMap(b => [
      b.text?.text ?? '',
      ...(b.fields?.map(f => f.text) ?? []),
    ]);
    expect(allText.some(t => t.includes('230'))).toBe(true);
  });
});
