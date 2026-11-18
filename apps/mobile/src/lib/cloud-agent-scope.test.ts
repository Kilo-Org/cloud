import { describe, expect, it } from 'vitest';

import { parseCloudAgentSessionId, parseOrganizationScope } from '@/lib/cloud-agent-scope';

const ORGANIZATION_ID = '5b0f5a0e-8a1f-4a54-9d0d-2a1c1b3d4e5f';

describe('parseCloudAgentSessionId', () => {
  it('keeps a session id', () => {
    expect(parseCloudAgentSessionId('agent_12345678-1234-4234-9234-123456789abc')).toBe(
      'agent_12345678-1234-4234-9234-123456789abc'
    );
  });

  it.each([undefined, null, '', '   ', 42, ['agent_1']])('reads %s as no cloud session', value => {
    expect(parseCloudAgentSessionId(value)).toBeNull();
  });
});

describe('parseOrganizationScope', () => {
  it('keeps a UUID scope', () => {
    expect(parseOrganizationScope(ORGANIZATION_ID)).toBe(ORGANIZATION_ID);
  });

  it.each([undefined, null, '', 'personal', 'undefined', ['x'], 7])(
    'reads %s as no organization scope',
    value => {
      expect(parseOrganizationScope(value)).toBeUndefined();
    }
  );
});
