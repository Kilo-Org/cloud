import { describe, expect, it } from 'vitest';
import { getDefaultAgentPanelState, getFooterControlDisplay } from './agent-chat-placeholder';

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

  it('provides compact footer labels for the sidebar controls', () => {
    expect(
      getFooterControlDisplay({
        mode: 'safe',
        model: 'Claude Sonnet 4',
        thinkingEffort: 'medium',
      })
    ).toStrictEqual({
      modeDescription: 'Read only',
      modeIcon: 'shield',
      modeIconTone: 'safe',
      modeLabel: 'Safe',
      modelLabel: 'Sonnet 4',
      thinkingLabel: 'Med',
    });

    expect(
      getFooterControlDisplay({
        mode: 'dangerous',
        model: 'Claude Opus 4',
        thinkingEffort: 'high',
      })
    ).toStrictEqual({
      modeDescription: 'Arbitrary webpage control',
      modeIcon: 'alert',
      modeIconTone: 'danger',
      modeLabel: 'Danger',
      modelLabel: 'Opus 4',
      thinkingLabel: 'High',
    });
  });
});
