import { describe, expect, it } from 'vitest';

import {
  shouldShowAgentWorkingIndicator,
  shouldShowFooterWorkingIndicator,
} from '@/components/agents/session-working-state';

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

describe('shouldShowFooterWorkingIndicator', () => {
  it('shows the working indicator when the agent is working and no status indicator is visible', () => {
    expect(
      shouldShowFooterWorkingIndicator({
        isAgentWorking: true,
        hasStatusIndicator: false,
      })
    ).toBe(true);
  });

  it('hides the working indicator when a status indicator is already visible', () => {
    expect(
      shouldShowFooterWorkingIndicator({
        isAgentWorking: true,
        hasStatusIndicator: true,
      })
    ).toBe(false);
  });

  it('hides the working indicator when the agent is idle', () => {
    expect(
      shouldShowFooterWorkingIndicator({
        isAgentWorking: false,
        hasStatusIndicator: false,
      })
    ).toBe(false);
  });
});
