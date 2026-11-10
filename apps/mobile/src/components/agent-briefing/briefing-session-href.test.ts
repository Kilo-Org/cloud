import { describe, expect, it } from 'vitest';

import { briefingSessionHref, briefingSourceHref } from './briefing-session-href';

const ORG_ID = '11111111-2222-4333-8444-555555555555';

const REPORT = {
  context: { id: 'context-org', organizationId: ORG_ID, name: 'Drain Test Org' },
  sessions: [
    {
      sessionId: 'ses_root',
      sources: [
        {
          id: 'status:one',
          sessionId: 'ses_root',
          kind: 'activity' as const,
          title: 'Session state',
          occurredAt: '2026-10-20T02:59:00.000Z',
          url: '/cloud/sessions/ses_root',
        },
        {
          id: 'artifact:plan',
          sessionId: 'ses_root',
          kind: 'artifact' as const,
          title: 'Session plan',
          occurredAt: '2026-10-20T03:32:00.000Z',
          url: '/cloud/sessions/ses_root',
        },
      ],
    },
  ],
};

describe('briefingSessionHref', () => {
  it('opens a named session in the report organization', () => {
    expect(briefingSessionHref(REPORT, 'ses_root')).toBe(
      `/(app)/agent-chat/ses_root?organizationId=${ORG_ID}`
    );
  });

  it('keeps a Personal report on the unscoped route', () => {
    expect(
      briefingSessionHref(
        { ...REPORT, context: { id: 'context-personal', organizationId: null, name: 'Personal' } },
        'ses_personal'
      )
    ).toBe('/(app)/agent-chat/ses_personal');
  });
});

describe('briefingSourceHref', () => {
  it('opens the root session of the group an evidence row was recorded under', () => {
    expect(
      briefingSourceHref(REPORT, { id: 'artifact:plan', sessionId: 'ses_child', kind: 'artifact' })
    ).toBe(`/(app)/agent-chat/ses_root?organizationId=${ORG_ID}`);
  });

  it('falls back to the source session when the report no longer lists the group', () => {
    expect(
      briefingSourceHref(REPORT, { id: 'status:gone', sessionId: 'ses_child', kind: 'activity' })
    ).toBe(`/(app)/agent-chat/ses_child?organizationId=${ORG_ID}`);
  });

  it('opens blockers in the same report context', () => {
    expect(
      briefingSourceHref(REPORT, { id: 'blocker:one', sessionId: 'ses_root', kind: 'blocker' })
    ).toBe(`/(app)/agent-chat/ses_root?organizationId=${ORG_ID}`);
  });

  it('leaves an external-link row to the caller', () => {
    expect(
      briefingSourceHref(REPORT, {
        id: 'pr:1',
        sessionId: 'ses_child',
        kind: 'pull_request',
      })
    ).toBeNull();
  });
});
