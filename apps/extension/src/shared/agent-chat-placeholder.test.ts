import { describe, expect, it } from 'vitest';
import { getFooterControlDisplay } from './agent-chat-placeholder';

describe('agent chat placeholder state', () => {
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
