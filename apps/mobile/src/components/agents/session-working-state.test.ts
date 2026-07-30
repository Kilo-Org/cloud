import { describe, expect, it } from 'vitest';

import {
  shouldShowAgentWorkingIndicator,
  shouldShowFooterWorkingIndicator,
  shouldShowSessionFooterRow,
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

describe('shouldShowSessionFooterRow', () => {
  const base = {
    shouldShowFooterWorking: false,
    hasStatusIndicator: true,
    messageCount: 1,
  };

  it('hides while preparing when the transcript shows an in-progress preparation', () => {
    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
      })
    ).toBe(false);
  });

  it('shows while preparing when the transcript has no live preparation surface', () => {
    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: false,
      })
    ).toBe(true);
  });

  it('shows while preparing when only a completed (stale) preparation is in the transcript', () => {
    // Recycle re-prepare: prior non-no-op completed group remains rendered, but
    // the new running attempt is not merged yet — footer must stay visible.
    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: false,
      })
    ).toBe(true);
  });

  it('hides while preparing when a running non-no-op preparation is in the transcript', () => {
    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
      })
    ).toBe(false);
  });

  it('keeps non-preparing behavior: shows when status or footer working is set', () => {
    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'ready',
        hasInProgressTranscriptPreparation: true,
        hasStatusIndicator: true,
        shouldShowFooterWorking: false,
      })
    ).toBe(true);

    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: null,
        hasInProgressTranscriptPreparation: false,
        hasStatusIndicator: false,
        shouldShowFooterWorking: true,
      })
    ).toBe(true);

    expect(
      shouldShowSessionFooterRow({
        ...base,
        cloudStatusType: 'ready',
        hasInProgressTranscriptPreparation: false,
        hasStatusIndicator: false,
        shouldShowFooterWorking: false,
      })
    ).toBe(false);
  });

  it('keeps footer-working rules and hides the row when there are no messages', () => {
    expect(
      shouldShowSessionFooterRow({
        cloudStatusType: null,
        hasInProgressTranscriptPreparation: false,
        shouldShowFooterWorking: true,
        hasStatusIndicator: false,
        messageCount: 3,
      })
    ).toBe(true);

    expect(
      shouldShowSessionFooterRow({
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: false,
        shouldShowFooterWorking: false,
        hasStatusIndicator: true,
        messageCount: 0,
      })
    ).toBe(false);

    expect(
      shouldShowSessionFooterRow({
        cloudStatusType: null,
        hasInProgressTranscriptPreparation: false,
        shouldShowFooterWorking: true,
        hasStatusIndicator: false,
        messageCount: 0,
      })
    ).toBe(false);
  });
});
