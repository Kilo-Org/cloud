import { describe, expect, it } from 'vitest';

import { resolveSendAttachmentKind } from '@/components/agents/session-detail-send-attachment';

describe('resolveSendAttachmentKind', () => {
  it.each([
    { activeSessionType: 'cloud-agent' as const, supports: true, has: true, expected: 'cloud' },
    { activeSessionType: 'cloud-agent' as const, supports: false, has: true, expected: 'cloud' },
    { activeSessionType: 'remote' as const, supports: true, has: true, expected: 'remote-capable' },
    { activeSessionType: 'remote' as const, supports: false, has: true, expected: 'none' },
    { activeSessionType: 'read-only' as const, supports: true, has: true, expected: 'none' },
    { activeSessionType: null, supports: true, has: true, expected: 'none' },
    { activeSessionType: undefined, supports: true, has: true, expected: 'none' },
    { activeSessionType: 'cloud-agent' as const, supports: true, has: false, expected: 'none' },
    { activeSessionType: 'remote' as const, supports: true, has: false, expected: 'none' },
  ])(
    'returns $expected for sessionType=$activeSessionType, supports=$supports, has=$has',
    ({ activeSessionType, supports, has, expected }) => {
      expect(resolveSendAttachmentKind(activeSessionType, supports, has)).toBe(expected);
    }
  );
});
