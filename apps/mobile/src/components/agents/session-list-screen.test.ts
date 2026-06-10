import { describe, expect, it } from 'vitest';

import { getNewAgentSessionPath } from '@/components/agents/session-list-routes';

describe('getNewAgentSessionPath', () => {
  it('routes personal sessions to the new agent screen', () => {
    expect(getNewAgentSessionPath(null)).toBe('/(app)/agent-chat/new');
  });

  it('preserves the organization context', () => {
    expect(getNewAgentSessionPath('org_123')).toBe('/(app)/agent-chat/new?organizationId=org_123');
  });
});
