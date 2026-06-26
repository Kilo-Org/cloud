import { describe, expect, it } from '@jest/globals';

import { sessionEventPayloadSchema } from './schemas';

describe('sessionEventPayloadSchema', () => {
  const session = {
    source: 'v2',
    sessionId: 'ses_1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    title: 'Test',
    createdOnPlatform: 'web',
    organizationId: 'org_external_1',
    gitUrl: null,
    gitBranch: null,
    parentSessionId: null,
    status: 'idle',
    statusUpdatedAt: null,
  };

  it('accepts non-UUID organization IDs in session row events', () => {
    const result = sessionEventPayloadSchema.safeParse({
      type: 'session.created',
      data: { source: 'v2', session, changedAt: session.updatedAt },
    });

    expect(result.success).toBe(true);
  });

  it('accepts non-UUID organization IDs in deleted events', () => {
    const result = sessionEventPayloadSchema.safeParse({
      type: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: session.sessionId,
        parentSessionId: null,
        organizationId: session.organizationId,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: 'web',
        deletedAt: '2026-01-01T00:00:02.000Z',
      },
    });

    expect(result.success).toBe(true);
  });
});
