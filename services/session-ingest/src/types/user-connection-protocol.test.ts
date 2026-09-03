import { describe, it, expect } from 'vitest';
import {
  CLIOutboundMessageSchema,
  CLIInboundMessageSchema,
  WebOutboundMessageSchema,
  WebInboundMessageSchema,
  SessionEventPayloadSchema,
} from './user-connection-protocol';

const validSessionId = 'ses_12345678901234567890123456';

describe('CLIOutboundMessageSchema', () => {
  it('parses valid heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: 'Fix bug' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses heartbeat with empty sessions', () => {
    const msg = { type: 'heartbeat', sessions: [] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses heartbeat with instance and per-session platform (kilo remote CLI)', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'laptop-1', projectName: 'kilo', version: '0.1.2' },
      sessions: [
        {
          id: 'ses_1',
          status: 'busy',
          title: 'Remote session',
          platform: 'darwin',
        },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toEqual({
        name: 'laptop-1',
        projectName: 'kilo',
        version: '0.1.2',
      });
      expect(result.data.sessions[0]).toMatchObject({ platform: 'darwin' });
    }
  });

  it('parses instance without version (optional field)', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'laptop-1', projectName: 'kilo' },
      sessions: [],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toEqual({ name: 'laptop-1', projectName: 'kilo' });
    }
  });

  it.each(['cli', 'remote'])('preserves full %s metadata and both capabilities', kind => {
    const msg = {
      type: 'heartbeat',
      protocolVersion: '1',
      capabilities: { attachments: true, sessionClone: true },
      instance: {
        name: 'laptop-1',
        projectName: 'kilo',
        version: '0.1.2',
        kind,
        startedAt: '2026-08-28T12:34:56.789Z',
        gitBranch: 'feature/identity',
      },
      sessions: [{ id: 'ses_1', status: 'busy', title: 'Remote session', platform: 'darwin' }],
    };
    expect(CLIOutboundMessageSchema.parse(msg)).toEqual(msg);
  });

  it.each([
    ['kind', 'terminal'],
    ['kind', null],
    ['startedAt', '2026-08-28T12:34:56Z'],
    ['startedAt', '2026-08-28T12:34:56.78Z'],
    ['startedAt', '2026-08-28T12:34:56.7890Z'],
    ['startedAt', '2026-08-28T12:34:56.789+00:00'],
    ['startedAt', '2026-02-30T12:34:56.789Z'],
    ['startedAt', null],
    ['gitBranch', null],
  ])('rejects invalid instance %s: %s', (field, value) => {
    expect(
      CLIOutboundMessageSchema.safeParse({
        type: 'heartbeat',
        sessions: [],
        instance: { name: 'host', projectName: 'project', [field]: value },
      }).success
    ).toBe(false);
  });

  it.each([
    ['ASCII', 'a'.repeat(24), 'a'.repeat(25)],
    ['escaped characters', '\\"'.repeat(12), '\\"'.repeat(12) + '\\'],
    ['CJK', '界'.repeat(24), '界'.repeat(25)],
    ['surrogate pairs', '\u{10400}'.repeat(24), '\u{10400}'.repeat(24) + 'a'],
  ])('bounds %s branches by Unicode code points, not units or bytes', (_label, valid, invalid) => {
    const heartbeat = {
      type: 'heartbeat',
      sessions: [],
      instance: { name: 'host', projectName: 'project', gitBranch: valid },
    };
    expect(CLIOutboundMessageSchema.parse(JSON.parse(JSON.stringify(heartbeat)))).toEqual(
      heartbeat
    );
    expect(
      CLIOutboundMessageSchema.safeParse({
        ...heartbeat,
        instance: { ...heartbeat.instance, gitBranch: invalid },
      }).success
    ).toBe(false);
  });

  it('rejects instance with empty name', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: '', projectName: 'kilo' },
      sessions: [],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects instance with oversize name', () => {
    const msg = {
      type: 'heartbeat',
      instance: { name: 'x'.repeat(65), projectName: 'kilo' },
      sessions: [],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects per-session platform that exceeds the 32-char cap', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 't', platform: 'x'.repeat(33) }],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('parses legacy heartbeat without instance or platform (backward compat regression)', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 'Legacy' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.instance).toBeUndefined();
      expect(result.data.sessions[0]).not.toHaveProperty('platform');
    }
  });

  it('parses heartbeat with parentSessionId on sessions', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        { id: 'root-1', status: 'busy', title: 'Root' },
        { id: 'child-1', status: 'busy', title: 'Child', parentSessionId: 'root-1' },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[1]).toHaveProperty('parentSessionId', 'root-1');
    }
  });

  it('parses heartbeat without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: 'ses_1', status: 'busy', title: 'Session' }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0]).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects heartbeat with null title', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [{ id: validSessionId, status: 'busy', title: null }],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg_1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { ok: true } };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses response with error only', () => {
    const msg = { type: 'response', id: 'req_err', error: 'not found' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown' };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('CLIOutboundMessageSchema capabilities', () => {
  const baseSession = { id: 'ses_cap_1', status: 'busy', title: 'cap' };

  it('accepts capabilities.attachments: true on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      protocolVersion: '1',
      capabilities: { attachments: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: true });
    }
  });

  it('accepts capabilities.attachments: false on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: false },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: false });
    }
  });

  it('accepts an absent capabilities field on a heartbeat (legacy CLI)', () => {
    const msg = { type: 'heartbeat', sessions: [baseSession] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toBeUndefined();
    }
  });

  it('accepts an empty capabilities object on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: {},
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({});
    }
  });

  it('rejects a non-boolean capabilities.attachments value', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: 'yes' },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('accepts capabilities.sessionClone: true on a heartbeat', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { sessionClone: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ sessionClone: true });
    }
  });

  it('accepts an absent sessionClone flag (legacy CLI)', () => {
    const msg = {
      type: 'heartbeat',
      capabilities: { attachments: true },
      sessions: [baseSession],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.capabilities).toEqual({ attachments: true });
    }
  });
});

describe('CLIOutboundMessageSchema prLink', () => {
  const baseSession = { id: 'ses_pr_1', status: 'busy', title: 'PR session' };

  it('parses a heartbeat session with a prLink', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: 'github', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 },
        },
      ],
    };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0].prLink).toEqual({
        platform: 'github',
        prUrl: 'https://github.com/o/r/pull/42',
        prNumber: 42,
      });
    }
  });

  it('parses a legacy heartbeat session without prLink', () => {
    const msg = { type: 'heartbeat', sessions: [baseSession] };
    const result = CLIOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'heartbeat') {
      expect(result.data.sessions[0]).not.toHaveProperty('prLink');
    }
  });

  it('rejects a prLink with an oversize prUrl', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: 'github', prUrl: 'x'.repeat(2049), prNumber: 42 },
        },
      ],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });

  it('rejects a prLink with a non-positive prNumber', () => {
    for (const prNumber of [0, -1]) {
      const msg = {
        type: 'heartbeat',
        sessions: [
          {
            ...baseSession,
            prLink: { platform: 'github', prUrl: 'https://github.com/o/r/pull/1', prNumber },
          },
        ],
      };
      expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
    }
  });

  it('rejects a prLink with an empty platform', () => {
    const msg = {
      type: 'heartbeat',
      sessions: [
        {
          ...baseSession,
          prLink: { platform: '', prUrl: 'https://github.com/o/r/pull/1', prNumber: 1 },
        },
      ],
    };
    expect(CLIOutboundMessageSchema.safeParse(msg).success).toBe(false);
  });
});

describe('CLIInboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'cmd_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hello' },
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command without sessionId', () => {
    const msg = {
      type: 'command',
      id: 'cmd_2',
      command: 'list_sessions',
      data: null,
    };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = { type: 'system', event: 'web.connected', data: {} };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('rejects subscribe with missing sessionId', () => {
    const msg = { type: 'subscribe' };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });

  it('parses valid heartbeat_ack', () => {
    const msg = { type: 'heartbeat_ack' };
    const result = CLIInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe('WebOutboundMessageSchema', () => {
  it('parses valid subscribe', () => {
    const msg = { type: 'subscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid unsubscribe', () => {
    const msg = { type: 'unsubscribe', sessionId: validSessionId };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid command', () => {
    const msg = {
      type: 'command',
      id: 'req_1',
      command: 'send_message',
      sessionId: validSessionId,
      data: { text: 'hi' },
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses command with connectionId', () => {
    const msg = {
      type: 'command',
      id: 'req_2',
      command: 'start_session',
      connectionId: 'conn_1',
      data: {},
    };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses viewer ping with a nonce', () => {
    const result = WebOutboundMessageSchema.safeParse({ type: 'ping', nonce: 'ping-1' });
    expect(result.success).toBe(true);
  });

  it('rejects viewer ping without a nonce', () => {
    const result = WebOutboundMessageSchema.safeParse({ type: 'ping' });
    expect(result.success).toBe(false);
  });

  it('rejects command without id', () => {
    const msg = { type: 'command', command: 'test', data: {} };
    const result = WebOutboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('WebInboundMessageSchema', () => {
  it('parses valid event', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid system', () => {
    const msg = {
      type: 'system',
      event: 'cli.connected',
      data: { connectionId: 'conn_1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses valid response', () => {
    const msg = { type: 'response', id: 'req_abc', result: { success: true } };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it('parses viewer pong with a nonce', () => {
    const result = WebInboundMessageSchema.safeParse({ type: 'pong', nonce: 'ping-1' });
    expect(result.success).toBe(true);
  });

  it('rejects viewer pong without a nonce', () => {
    const result = WebInboundMessageSchema.safeParse({ type: 'pong' });
    expect(result.success).toBe(false);
  });

  it('parses event with parentSessionId', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      parentSessionId: 'parent-ses-1',
      event: 'message.updated',
      data: { id: 'msg-1' },
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('parentSessionId', 'parent-ses-1');
    }
  });

  it('parses event without parentSessionId (backward compat)', () => {
    const msg = {
      type: 'event',
      sessionId: validSessionId,
      event: 'session.updated',
      data: {},
    };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty('parentSessionId');
    }
  });

  it('rejects unknown type', () => {
    const msg = { type: 'unknown', data: {} };
    const result = WebInboundMessageSchema.safeParse(msg);
    expect(result.success).toBe(false);
  });
});

describe('SessionEventPayloadSchema', () => {
  const session = {
    source: 'v2',
    sessionId: validSessionId,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Test',
    createdOnPlatform: 'web',
    organizationId: null,
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: null,
  };

  it('parses semantic v2 session events', () => {
    const events = [
      { type: 'session.created', data: { source: 'v2', session, changedAt: session.updatedAt } },
      { type: 'session.updated', data: { source: 'v2', session, changedAt: session.updatedAt } },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: null,
          status: 'idle',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.deleted',
        data: {
          source: 'v2',
          sessionId: validSessionId,
          parentSessionId: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          createdOnPlatform: 'web',
          deletedAt: '2026-01-01T00:00:02.000Z',
        },
      },
    ];

    for (const event of events) {
      expect(SessionEventPayloadSchema.safeParse(event).success).toBe(true);
    }
  });

  it.each(['session.created', 'session.updated'] as const)(
    'preserves a worktree ID in %s events',
    type => {
      const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
      const result = SessionEventPayloadSchema.parse({
        type,
        data: {
          source: 'v2',
          session: { ...session, worktreeId },
          changedAt: session.updatedAt,
        },
      });

      expect(result.data).toHaveProperty('session.worktreeId', worktreeId);
    }
  );

  it('preserves a worktree ID in full-row status events', () => {
    const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
    const result = SessionEventPayloadSchema.parse({
      type: 'session.status.updated',
      data: {
        source: 'v2',
        session: { ...session, worktreeId },
        previousStatus: null,
        status: 'idle',
        statusUpdatedAt: null,
        changedAt: session.updatedAt,
      },
    });

    expect(result.data).toHaveProperty('session.worktreeId', worktreeId);
  });

  it.each([null, undefined])('accepts legacy sessions with worktree ID %s', worktreeId => {
    const result = SessionEventPayloadSchema.parse({
      type: 'session.created',
      data: {
        source: 'v2',
        session: { ...session, ...(worktreeId === undefined ? {} : { worktreeId }) },
        changedAt: session.updatedAt,
      },
    });

    expect('session' in result.data ? result.data.session.worktreeId : undefined).toBe(worktreeId);
  });

  it('parses lightweight status update payloads during rollout compatibility', () => {
    const result = SessionEventPayloadSchema.safeParse({
      type: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: validSessionId,
        previousStatus: 'idle',
        status: 'busy',
        statusUpdatedAt: '2026-01-01T00:00:02.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        changedAt: '2026-01-01T00:00:02.000Z',
      },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid v2 session statuses', () => {
    const events = [
      {
        type: 'session.updated',
        data: {
          source: 'v2',
          session: { ...session, status: 'unknown' },
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: 'active',
          status: 'idle',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
      {
        type: 'session.status.updated',
        data: {
          source: 'v2',
          session,
          previousStatus: null,
          status: 'active',
          statusUpdatedAt: null,
          changedAt: session.updatedAt,
        },
      },
    ];

    for (const event of events) {
      expect(SessionEventPayloadSchema.safeParse(event).success).toBe(false);
    }
  });

  it('rejects non-v2 source and legacy identity fields', () => {
    const result = SessionEventPayloadSchema.safeParse({
      type: 'session.created',
      data: {
        source: 'v1',
        session: { ...session, kiloUserId: 'usr_1', projectId: 'proj_1', platform: 'web' },
        changedAt: session.updatedAt,
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('extra fields', () => {
  it('strips unknown fields by default on strict objects', () => {
    const msg = {
      type: 'subscribe',
      sessionId: validSessionId,
      extra: 'should-be-stripped',
    };
    const result = WebOutboundMessageSchema.parse(msg);
    expect(result).not.toHaveProperty('extra');
  });
});
