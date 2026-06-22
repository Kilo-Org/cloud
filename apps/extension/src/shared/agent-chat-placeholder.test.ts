import { describe, expect, it } from 'vitest';
import { getDefaultAgentPanelState } from './agent-chat-placeholder';

describe('agent chat placeholder state', () => {
  it('provides the initial extension agent shell defaults', () => {
    expect(getDefaultAgentPanelState()).toStrictEqual({
      draft: '',
      footer: {
        mode: 'safe',
        model: 'Claude Sonnet 4',
        thinkingEffort: 'medium',
      },
      messages: [
        {
          body: 'I can inspect the selected tab, read page structure, and prepare browser actions.',
          role: 'agent',
        },
        {
          body: 'Check this page and tell me what Kilo can do here.',
          role: 'user',
        },
        {
          body: 'Ready. Safe mode is on, so I will only read page context until you change modes.',
          role: 'agent',
        },
      ],
    });
  });
});
