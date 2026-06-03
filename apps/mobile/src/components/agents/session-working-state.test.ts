import { describe, expect, it } from 'vitest';

import { shouldShowAgentWorkingIndicator } from '@/components/agents/session-working-state';

describe('shouldShowAgentWorkingIndicator', () => {
  it('shows while the agent is streaming', () => {
    expect(
      shouldShowAgentWorkingIndicator({
        isStreaming: true,
        pendingMessageCount: 0,
      })
    ).toBe(true);
  });

  it('shows while a prompt is queued before streaming starts', () => {
    expect(
      shouldShowAgentWorkingIndicator({
        isStreaming: false,
        pendingMessageCount: 1,
      })
    ).toBe(true);
  });

  it('hides when there is no stream or queued prompt', () => {
    expect(
      shouldShowAgentWorkingIndicator({
        isStreaming: false,
        pendingMessageCount: 0,
      })
    ).toBe(false);
  });
});
