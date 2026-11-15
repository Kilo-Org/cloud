import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  glanceableCountLines,
  glanceableScheduledAt,
  glanceableSpokenLabel,
  glanceableSpokenLabelKeys,
  glanceableStatusCopyKey,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from './presentation';

const NOW = 1_750_000_000_000;

function snapshot(overrides: {
  sessions?: { status: string; scheduledAt?: string }[];
  status?: GlanceableAgentsSnapshot['status'];
}): GlanceableAgentsSnapshot {
  return buildGlanceableSnapshot({
    sessions: overrides.sessions ?? [],
    userId: 'u1',
    organizationId: null,
    now: NOW,
    status: overrides.status,
  });
}

describe('presentation precedence', () => {
  it('signed-out flag wins over org-invalid and the snapshot status', () => {
    expect(resolveGlanceableStatus(snapshot({ status: 'happy' }), { signedOut: true })).toBe(
      'signed_out'
    );
    expect(
      resolveGlanceableStatus(snapshot({ status: 'happy' }), { signedOut: true, orgInvalid: true })
    ).toBe('signed_out');
  });

  it('org-invalid flag maps to privacy over the snapshot status', () => {
    expect(resolveGlanceableStatus(snapshot({ status: 'stale' }), { orgInvalid: true })).toBe(
      'privacy'
    );
  });

  it('falls back to the snapshot status when no flag is set', () => {
    expect(resolveGlanceableStatus(snapshot({ status: 'waiting' }))).toBe('waiting');
    expect(resolveGlanceableStatus(snapshot({ status: 'happy' }))).toBe('happy');
  });
});

describe('primary rank and locked copy keys', () => {
  it('ranks needs-input, then running, then scheduled, then idle', () => {
    const mixed = snapshot({
      sessions: [
        { status: 'busy' },
        { status: 'busy' },
        { status: 'busy' },
        { status: 'retry' },
        { status: 'question' },
      ],
    });
    // `retry` folds into needs-input, so the question plus the retry make 2.
    expect(primaryGlanceableCount(mixed)).toEqual({
      key: 'glanceable.needsInput',
      kind: 'needsInput',
      count: 2,
    });

    const noInput = snapshot({ sessions: [{ status: 'busy' }, { status: 'idle' }] });
    expect(primaryGlanceableCount(noInput)).toEqual({
      key: 'common.working',
      kind: 'running',
      count: 1,
    });

    const onlyScheduled = snapshot({ sessions: [{ status: 'scheduled' }] });
    expect(primaryGlanceableCount(onlyScheduled)).toEqual({
      key: 'common.scheduled',
      kind: 'scheduled',
      count: 1,
    });

    const onlyIdle = snapshot({ sessions: [{ status: 'idle' }] });
    expect(primaryGlanceableCount(onlyIdle)).toEqual({
      key: 'common.idle',
      kind: 'idle',
      count: 1,
    });

    const onlyRunning = snapshot({ sessions: [{ status: 'busy' }, { status: 'busy' }] });
    expect(primaryGlanceableCount(onlyRunning)).toEqual({
      key: 'common.working',
      kind: 'running',
      count: 2,
    });

    expect(primaryGlanceableCount(snapshot({}))).toBeNull();
  });

  it('maps each non-happy status to its locked copy key', () => {
    expect(glanceableStatusCopyKey(snapshot({ status: 'waiting' }))).toBe('glanceable.waiting');
    expect(glanceableStatusCopyKey(snapshot({ status: 'empty' }))).toBe('glanceable.empty');
    expect(glanceableStatusCopyKey(snapshot({ status: 'stale' }))).toBe('glanceable.stale');
    expect(glanceableStatusCopyKey(snapshot({ status: 'expired' }))).toBe('glanceable.expired');
    expect(glanceableStatusCopyKey(snapshot({ status: 'signed_out' }))).toBe(
      'glanceable.signedOut'
    );
    expect(glanceableStatusCopyKey(snapshot({ status: 'privacy' }))).toBe('glanceable.privacy');
    expect(glanceableStatusCopyKey(snapshot({ status: 'happy' }))).toBeNull();
  });
});

describe('scheduled count and wake time', () => {
  const WAKE = '2026-09-24T09:00:00.000Z';

  it('draws a scheduled count line with the shared Scheduled key', () => {
    const lines = glanceableCountLines(
      snapshot({ sessions: [{ status: 'scheduled', scheduledAt: WAKE }] })
    );
    expect(lines).toContainEqual({ key: 'common.scheduled', kind: 'scheduled', count: 1 });
    expect(lines.map(line => line.kind)).toEqual(['needsInput', 'running', 'scheduled', 'idle']);
  });

  it('returns the snapshot wake while something is scheduled', () => {
    expect(
      glanceableScheduledAt(snapshot({ sessions: [{ status: 'scheduled', scheduledAt: WAKE }] }))
    ).toBe(WAKE);
  });

  it('returns no wake when nothing is scheduled', () => {
    expect(glanceableScheduledAt(snapshot({ sessions: [{ status: 'busy' }] }))).toBeNull();
  });

  it('drops a carried wake time once the scheduled count falls to zero', () => {
    const woke = {
      ...snapshot({ sessions: [{ status: 'scheduled', scheduledAt: WAKE }] }),
      scheduled: 0,
    };
    expect(woke.scheduledAt).toBe(WAKE);
    expect(glanceableScheduledAt(woke)).toBeNull();
  });

  it('yields no wake time for a scheduled count whose rows carried none', () => {
    const noWake = snapshot({ sessions: [{ status: 'scheduled' }] });
    expect(noWake.scheduled).toBe(1);
    expect(noWake.scheduledAt).toBeNull();
    expect(glanceableScheduledAt(noWake)).toBeNull();
  });
});

describe('spoken label shape', () => {
  it('speaks counts then Open agents for happy, never a title or id', () => {
    const happy = snapshot({ sessions: [{ status: 'busy' }, { status: 'question' }] });
    expect(glanceableSpokenLabelKeys(happy)).toEqual([
      'glanceable.needsInput',
      'common.working',
      'glanceable.openAgents',
    ]);
    expect(glanceableSpokenLabelKeys(happy).join(' ')).not.toContain('u1');
  });

  it('speaks the status word then Open agents for non-happy statuses', () => {
    expect(glanceableSpokenLabelKeys(snapshot({ status: 'empty' }))).toEqual([
      'glanceable.empty',
      'glanceable.openAgents',
    ]);
    expect(glanceableSpokenLabelKeys(snapshot({ status: 'signed_out' }))).toEqual([
      'glanceable.signedOut',
      'glanceable.openAgents',
    ]);
  });
});
describe('numeric spoken label', () => {
  // The keys stand in for translated copy, so this translator answers the list
  // joiner the way a comma-joining catalog does and echoes every other key.
  const echoTranslate = (key: string): string => (key === 'common.listJoiner' ? ', ' : key);

  it('speaks numeric counts then Open agents for happy', () => {
    const happy = snapshot({
      sessions: [{ status: 'busy' }, { status: 'busy' }, { status: 'question' }],
    });
    expect(glanceableSpokenLabel(happy, {}, echoTranslate, String)).toBe(
      '1 glanceable.needsInput, 2 common.working, glanceable.openAgents'
    );
  });

  it('speaks the status word, numeric counts, then Open agents for stale', () => {
    const stale = snapshot({ sessions: [{ status: 'busy' }], status: 'stale' });
    expect(glanceableSpokenLabel(stale, {}, echoTranslate, String)).toBe(
      'glanceable.stale, 1 common.working, glanceable.openAgents'
    );
  });

  it('speaks the status word then Open agents when no counts exist', () => {
    expect(glanceableSpokenLabel(snapshot({ status: 'empty' }), {}, echoTranslate, String)).toBe(
      'glanceable.empty, glanceable.openAgents'
    );
  });

  it('never speaks a title, organization name, or raw id', () => {
    const spoken = glanceableSpokenLabel(
      snapshot({ sessions: [{ status: 'busy' }] }),
      {},
      echoTranslate,
      String
    );
    expect(spoken).not.toContain('u1');
  });
});

describe('numeric spoken label', () => {
  const copy: Record<string, string> = {
    'glanceable.needsInput': 'Needs input',
    'common.idle': 'Idle',
    'common.working': 'Working',
    'common.scheduled': 'Scheduled',
    'glanceable.waiting': 'Waiting for agents',
    'glanceable.empty': 'No work in progress',
    'glanceable.stale': 'Updates delayed',
    'glanceable.expired': 'Status expired',
    'glanceable.signedOut': 'Sign in to see agents',
    'glanceable.privacy': 'Open Kilo to see agents',
    'glanceable.openAgents': 'Open agents',
    'common.listJoiner': ', ',
  };
  const translate = (key: string): string => copy[key] ?? key;
  const mixed = {
    ...snapshot({ status: 'happy' }),
    needsInput: 2,
    idle: 3,
    running: 4,
  };

  it('speaks each numeric count in rank order before Open agents', () => {
    expect(glanceableSpokenLabel(mixed, {}, translate, String)).toBe(
      '2 Needs input, 4 Working, 3 Idle, Open agents'
    );
  });

  it('speaks the translated stale warning before retained numeric counts', () => {
    expect(glanceableSpokenLabel({ ...mixed, status: 'stale' }, {}, translate, String)).toBe(
      'Updates delayed, 2 Needs input, 4 Working, 3 Idle, Open agents'
    );
  });

  it('speaks stale copy without inventing counts when none remain', () => {
    expect(glanceableSpokenLabel(snapshot({ status: 'stale' }), {}, translate, String)).toBe(
      'Updates delayed, Open agents'
    );
  });

  it.each([
    ['waiting', 'Waiting for agents, Open agents'],
    ['empty', 'No work in progress, Open agents'],
    ['expired', 'Status expired, Open agents'],
    ['signed_out', 'Sign in to see agents, Open agents'],
    ['privacy', 'Open Kilo to see agents, Open agents'],
  ] as const)('hides numeric counts when the status is %s', (status, expected) => {
    expect(glanceableSpokenLabel({ ...mixed, status }, {}, translate, String)).toBe(expected);
  });

  it('keeps signed-out and privacy overrides ahead of stale counts', () => {
    const stale = { ...mixed, status: 'stale' as const };
    expect(
      glanceableSpokenLabel(stale, { signedOut: true, orgInvalid: true }, translate, String)
    ).toBe('Sign in to see agents, Open agents');
    expect(glanceableSpokenLabel(stale, { orgInvalid: true }, translate, String)).toBe(
      'Open Kilo to see agents, Open agents'
    );
  });

  it('separates the spoken parts with the catalog list joiner', () => {
    const ideographic = (key: string): string =>
      key === 'common.listJoiner' ? '、' : translate(key);
    expect(
      glanceableSpokenLabel(
        snapshot({ sessions: [{ status: 'busy' }, { status: 'question' }] }),
        {},
        ideographic,
        String
      )
    ).toBe('1 Needs input、1 Working、Open agents');
  });

  it('speaks counts through the surface formatter', () => {
    expect(glanceableSpokenLabel(mixed, {}, translate, value => `[${value}]`)).toBe(
      '[2] Needs input, [4] Working, [3] Idle, Open agents'
    );
  });
});
