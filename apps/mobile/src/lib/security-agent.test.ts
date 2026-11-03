import { describe, expect, it } from 'vitest';

import { getSecurityAgentPath, parseSecurityScope } from '@/lib/security-agent';

const ORG_ID = 'c0a8012e-9a3b-4f5c-8d1e-2b3c4d5e6f70';

describe('Security Agent helpers', () => {
  it('builds personal and organization routes', () => {
    expect(getSecurityAgentPath('personal', 'findings')).toBe(
      '/(app)/security-agent/personal/findings'
    );
    expect(getSecurityAgentPath('org_123', 'settings/automation')).toBe(
      '/(app)/security-agent/org_123/settings/automation'
    );
  });
});

describe('parseSecurityScope', () => {
  it('accepts the personal scope and an organization id', () => {
    expect(parseSecurityScope('personal')).toBe('personal');
    expect(parseSecurityScope(ORG_ID)).toBe(ORG_ID);
    expect(parseSecurityScope(ORG_ID.toUpperCase())).toBe(ORG_ID.toUpperCase());
  });

  it('rejects a missing or repeated segment', () => {
    expect(parseSecurityScope(undefined)).toBeNull();
    expect(parseSecurityScope('')).toBeNull();
    expect(parseSecurityScope(['personal', 'personal'])).toBeNull();
  });

  it('rejects a segment a lost navigation serialized as text', () => {
    // These reached the organization procedures with a non-uuid owner id and
    // the server's BAD_REQUEST surfaced as an unrecoverable load error.
    expect(parseSecurityScope('undefined')).toBeNull();
    expect(parseSecurityScope('null')).toBeNull();
    expect(parseSecurityScope('[object Object]')).toBeNull();
    expect(parseSecurityScope('personal ')).toBeNull();
    expect(parseSecurityScope('not-an-org-id')).toBeNull();
  });
});
