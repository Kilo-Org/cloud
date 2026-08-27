import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';
import { describe, expect, it } from 'vitest';

import { buildAndroidWidgetProps, buildOngoingNotificationText } from './widget-props';

const NOW = 1_750_000_000_000;

const translate = (key: string): string => key;

function snapshotFor(
  sessions: { status: string }[],
  revision = 0,
  status?: GlanceableAgentsSnapshot['status']
): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions,
    userId: 'u1',
    organizationId: null,
    now: NOW,
    previousRevision: revision,
    ...(status === undefined ? {} : { status }),
  });
}

describe('buildAndroidWidgetProps', () => {
  it('ranks the compact primary count as needs-input, then reconnecting, then running', () => {
    const props = buildAndroidWidgetProps(
      snapshotFor(
        [{ status: 'busy' }, { status: 'busy' }, { status: 'retry' }, { status: 'question' }],
        0
      ),
      {},
      translate
    );
    expect(props.primaryLabel).toBe('glanceable.needsInput');
    expect(props.primaryCount).toBe(1);
    expect(props.countLines.map(line => line.label)).toEqual([
      'glanceable.needsInput',
      'glanceable.reconnecting',
      'glanceable.running',
    ]);
  });

  it('applies the locked copy matrix per status', () => {
    const cases: [
      GlanceableAgentsSnapshot['status'],
      { status: string }[],
      string,
      number,
      boolean,
    ][] = [
      ['empty', [], 'glanceable.empty', 0, false],
      ['stale', [{ status: 'busy' }], 'glanceable.stale', 1, true],
      ['expired', [], 'glanceable.expired', 0, false],
      ['signed_out', [], 'glanceable.signedOut', 0, false],
      ['privacy', [], 'glanceable.privacy', 0, false],
    ];
    for (const [status, sessions, statusLine, counts, showOpenAgents] of cases) {
      const props = buildAndroidWidgetProps(snapshotFor(sessions, 0, status), {}, translate);
      expect(props.statusLine).toBe(statusLine);
      expect(props.countLines).toHaveLength(counts);
      expect(props.showOpenAgents).toBe(showOpenAgents);
    }
  });

  it('carries no title, organization name, or raw id into the widget payload', () => {
    const snapshot = buildGlanceableSnapshot({
      sessions: [{ status: 'busy' }],
      userId: 'user-9f3a-leak',
      organizationId: 'org-acme-7-leak',
      now: NOW,
      previousEligibleStartedAt: new Date(NOW - 60_000).toISOString(),
    });

    const props = buildAndroidWidgetProps(snapshot, {}, translate);
    const json = JSON.stringify(props);

    expect(Object.keys(props).toSorted()).toEqual([
      'accessibilityLabel',
      'countLines',
      'openAgentsLabel',
      'primaryCount',
      'primaryLabel',
      'showOpenAgents',
      'statusLine',
    ]);
    expect(json).not.toContain('user-9f3a-leak');
    expect(json).not.toContain('org-acme-7-leak');
    expect(json).not.toContain(snapshot.scopeKey);
    expect(json).not.toContain(snapshot.updatedAt);
    expect(json).not.toContain('revision');
    expect(json).not.toContain('title');
  });
});

describe('buildOngoingNotificationText', () => {
  it('lists ranked counts for happy and stale, otherwise the locked copy', () => {
    const happy = snapshotFor([{ status: 'busy' }, { status: 'question' }], 0);
    expect(buildOngoingNotificationText(happy, {}, translate)).toBe(
      '1 glanceable.needsInput, 1 glanceable.running'
    );

    const stale = snapshotFor([{ status: 'retry' }], 0, 'stale');
    expect(buildOngoingNotificationText(stale, {}, translate)).toBe('1 glanceable.reconnecting');

    const empty = snapshotFor([], 0, 'empty');
    expect(buildOngoingNotificationText(empty, {}, translate)).toBe('glanceable.empty');

    const privacy = snapshotFor([], 0, 'privacy');
    expect(buildOngoingNotificationText(privacy, {}, translate)).toBe('glanceable.privacy');
  });
});
