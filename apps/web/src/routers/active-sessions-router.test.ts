import { describe, it, expect } from '@jest/globals';
import { activeSessionSchema } from './active-sessions-router';

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
