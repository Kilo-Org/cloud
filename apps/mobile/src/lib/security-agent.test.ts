import { describe, expect, it } from 'vitest';

import { getSecurityAgentPath } from '@/lib/security-agent';

describe('Security Agent helpers', () => {
  it('builds personal and organization routes', () => {
    expect(getSecurityAgentPath('personal', 'findings')).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/personal/findings'
    );
    expect(getSecurityAgentPath('org_123', 'settings/automation')).toBe(
      '/(app)/(tabs)/(3_profile)/security-agent/org_123/settings/automation'
    );
  });
});
