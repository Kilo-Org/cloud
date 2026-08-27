import { describe, expect, it } from 'vitest';

import {
  buildGlanceableSnapshot,
  type GlanceableAgentsSnapshot,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import {
  glanceableSpokenLabel,
  glanceableSpokenLabelKeys,
  glanceableStatusCopyKey,
  primaryGlanceableCount,
  resolveGlanceableStatus,
} from './presentation';

const NOW = 1_750_000_000_000;

function snapshot(overrides: {
  sessions?: { status: string }[];
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
  it('ranks needs-input, then reconnecting, then running', () => {
    const mixed = snapshot({
      sessions: [
        { status: 'busy' },
        { status: 'busy' },
        { status: 'busy' },
        { status: 'retry' },
        { status: 'question' },
      ],
    });
    expect(primaryGlanceableCount(mixed)).toEqual({ key: 'glanceable.needsInput', count: 1 });

    const noInput = snapshot({ sessions: [{ status: 'busy' }, { status: 'retry' }] });
    expect(primaryGlanceableCount(noInput)).toEqual({ key: 'glanceable.reconnecting', count: 1 });

    const onlyRunning = snapshot({ sessions: [{ status: 'busy' }, { status: 'busy' }] });
    expect(primaryGlanceableCount(onlyRunning)).toEqual({ key: 'glanceable.running', count: 2 });

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

describe('spoken label shape', () => {
  it('speaks counts then Open agents for happy, never a title or id', () => {
    const happy = snapshot({ sessions: [{ status: 'busy' }, { status: 'question' }] });
    expect(glanceableSpokenLabelKeys(happy)).toEqual([
      'glanceable.needsInput',
      'glanceable.running',
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
  it('speaks numeric counts then Open agents for happy', () => {
    const happy = snapshot({
      sessions: [{ status: 'busy' }, { status: 'busy' }, { status: 'question' }],
    });
    expect(glanceableSpokenLabel(happy, {}, key => key)).toBe(
      '1 glanceable.needsInput, 2 glanceable.running, glanceable.openAgents'
    );
  });

  it('speaks the status word, numeric counts, then Open agents for stale', () => {
    const stale = snapshot({ sessions: [{ status: 'busy' }], status: 'stale' });
    expect(glanceableSpokenLabel(stale, {}, key => key)).toBe(
      'glanceable.stale, 1 glanceable.running, glanceable.openAgents'
    );
  });

  it('speaks the status word then Open agents when no counts exist', () => {
    expect(glanceableSpokenLabel(snapshot({ status: 'empty' }), {}, key => key)).toBe(
      'glanceable.empty, glanceable.openAgents'
    );
  });

  it('never speaks a title, organization name, or raw id', () => {
    const spoken = glanceableSpokenLabel(
      snapshot({ sessions: [{ status: 'busy' }] }),
      {},
      key => key
    );
    expect(spoken).not.toContain('u1');
  });
});
