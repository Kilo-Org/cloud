import { describe, expect, it, vi } from 'vitest';

import {
  getAgentSessionPath,
  replaceWithAgentSession,
} from '@/components/agents/session-detail-routes';

const SESSION_ID = 'ses_12345678901234567890123456';
const ORG_ID = 'org_abc123';

describe('getAgentSessionPath', () => {
  it('routes personal sessions to the canonical agent-chat detail screen', () => {
    expect(getAgentSessionPath(SESSION_ID)).toBe(`/(app)/agent-chat/${SESSION_ID}`);
  });

  it('preserves the organization context when provided', () => {
    expect(getAgentSessionPath(SESSION_ID, ORG_ID)).toBe(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}`
    );
  });

  it('treats an empty organizationId as the personal case', () => {
    expect(getAgentSessionPath(SESSION_ID, '')).toBe(`/(app)/agent-chat/${SESSION_ID}`);
  });
});

describe('replaceWithAgentSession', () => {
  it('replaces with the personal agent-chat route exactly once', () => {
    const router = { replace: vi.fn(() => undefined) };

    replaceWithAgentSession(router, SESSION_ID);

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(`/(app)/agent-chat/${SESSION_ID}`);
  });

  it('replaces with the org-scoped agent-chat route when organizationId is provided', () => {
    const router = { replace: vi.fn(() => undefined) };

    replaceWithAgentSession(router, SESSION_ID, ORG_ID);

    expect(router.replace).toHaveBeenCalledTimes(1);
    expect(router.replace).toHaveBeenCalledWith(
      `/(app)/agent-chat/${SESSION_ID}?organizationId=${ORG_ID}`
    );
  });
});
