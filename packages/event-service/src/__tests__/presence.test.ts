import { describe, expect, it } from 'vitest';

import {
  presenceContextForAgentSession,
  presenceContextForConversation,
  presenceContextForInstance,
  presenceContextForPlatform,
} from '../presence';

describe('presence contexts', () => {
  it('builds the platform presence path', () => {
    expect(presenceContextForPlatform('app')).toBe('/presence/app');
    expect(presenceContextForPlatform('web')).toBe('/presence/web');
  });

  it('builds the instance presence path under /presence', () => {
    expect(presenceContextForInstance('sandbox-1')).toBe('/presence/kiloclaw/sandbox-1');
  });

  it('builds the conversation presence path under /presence', () => {
    expect(presenceContextForConversation('sandbox-1', 'conv-1')).toBe(
      '/presence/kiloclaw/sandbox-1/conv-1'
    );
  });

  it('builds the per-agent-session presence path under /presence', () => {
    expect(presenceContextForAgentSession('ses_1')).toBe('/presence/agent-session/ses_1');
  });

  it('builds distinct per-session paths for different cliSessionIds', () => {
    expect(presenceContextForAgentSession('ses_1')).not.toBe(
      presenceContextForAgentSession('ses_2')
    );
  });
});
