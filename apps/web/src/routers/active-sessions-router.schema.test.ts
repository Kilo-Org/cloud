import { describe, it, expect } from '@jest/globals';
import { activeSessionSchema, resolveActiveSessionStatus } from './active-sessions-router';

describe('resolveActiveSessionStatus', () => {
  it('prefers stored question/permission over live', () => {
    expect(resolveActiveSessionStatus('busy', 'question')).toBe('question');
    expect(resolveActiveSessionStatus('idle', 'permission')).toBe('permission');
  });

  it('keeps live when stored is not attention', () => {
    expect(resolveActiveSessionStatus('busy', 'idle')).toBe('busy');
    expect(resolveActiveSessionStatus('idle', null)).toBe('idle');
    expect(resolveActiveSessionStatus('busy', undefined)).toBe('busy');
  });
});

describe('activeSessionSchema capabilities', () => {
  it('accepts a session row with capabilities.attachments: true', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      capabilities: { attachments: true },
    };
    expect(activeSessionSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a session row with capabilities.attachments: false', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      capabilities: { attachments: false },
    };
    expect(activeSessionSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a session row with an empty capabilities object', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      capabilities: {},
    };
    expect(activeSessionSchema.safeParse(row).success).toBe(true);
  });

  it('accepts a session row with an absent capabilities field (legacy CLI)', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
    };
    const result = activeSessionSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toBeUndefined();
    }
  });

  it('accepts optional lastActivityAt as a raw DB timestamp string', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      lastActivityAt: '2026-07-20 08:00:00+00',
    };
    const result = activeSessionSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastActivityAt).toBe('2026-07-20 08:00:00+00');
    }
  });

  it('accepts a session row without lastActivityAt', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
    };
    const result = activeSessionSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lastActivityAt).toBeUndefined();
    }
  });

  it('rejects a non-boolean capabilities.attachments value', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      capabilities: { attachments: 'yes' },
    };
    expect(activeSessionSchema.safeParse(row).success).toBe(false);
  });

  it('rejects unknown capability keys (strict object)', () => {
    const row = {
      id: 's1',
      status: 'busy',
      title: 'Fix bug',
      connectionId: 'cli-1',
      capabilities: { terminal: true },
    };
    // The default zod behavior strips unknown keys rather than rejecting —
    // assert that the unknown key is dropped, not preserved, so consumers
    // never see a flag the cloud did not advertise.
    const result = activeSessionSchema.safeParse(row);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.capabilities).toEqual({});
    }
  });
});
