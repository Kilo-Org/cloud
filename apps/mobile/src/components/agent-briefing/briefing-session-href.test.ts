import { describe, expect, it } from 'vitest';

import { briefingSessionHref, briefingSourceHref } from './briefing-session-href';

const ORG_ID = '11111111-2222-4333-8444-555555555555';

const REPORT = {
  context: { organizationId: ORG_ID },
  sessions: [
    {
      sessionId: 'ses_root',
      sources: [{ id: 'status:one' }, { id: 'usage:charge' }],
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
      briefingSessionHref({ ...REPORT, context: { organizationId: null } }, 'ses_personal')
    ).toBe('/(app)/agent-chat/ses_personal');
  });
});

describe('briefingSourceHref', () => {
  it('opens the root session of the group an evidence row was recorded under', () => {
    expect(
      briefingSourceHref(REPORT, { id: 'usage:charge', sessionId: 'ses_child', kind: 'cost' })
    ).toBe(`/(app)/agent-chat/ses_root?organizationId=${ORG_ID}`);
  });

  it('falls back to the source session when the report no longer lists the group', () => {
    expect(
      briefingSourceHref(REPORT, { id: 'status:gone', sessionId: 'ses_child', kind: 'activity' })
    ).toBe(`/(app)/agent-chat/ses_child?organizationId=${ORG_ID}`);
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
