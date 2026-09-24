import { describe, expect, it } from 'vitest';

import {
  resolveSessionFooterRowItem,
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

describe('resolveSessionFooterRowItem', () => {
  const base = {
    cloudStatusType: 'ready' as const,
    hasInProgressTranscriptPreparation: false,
    shouldShowFooterWorking: false,
    hasStatusIndicator: false,
    hasSendReason: false,
    messageCount: 1,
  };

  it('ranks the working spinner above the status indicator and the send reason', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        shouldShowFooterWorking: true,
        hasStatusIndicator: true,
        hasSendReason: true,
      })
    ).toBe('working');
  });

  it('ranks the status indicator above the send reason', () => {
    expect(
      resolveSessionFooterRowItem({ ...base, hasStatusIndicator: true, hasSendReason: true })
    ).toBe('status');
  });

  it('shows the send reason when nothing above it applies', () => {
    expect(resolveSessionFooterRowItem({ ...base, hasSendReason: true })).toBe('reason');
  });

  it('shows no item when no input applies', () => {
    expect(resolveSessionFooterRowItem(base)).toBeNull();
  });

  it('suppresses progress items while preparing when the transcript shows an in-progress preparation', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
        shouldShowFooterWorking: true,
        hasStatusIndicator: true,
      })
    ).toBeNull();
  });

  it('keeps the send reason while preparing with a live preparation in the transcript', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
        shouldShowFooterWorking: true,
        hasSendReason: true,
      })
    ).toBe('reason');
  });

  it('keeps progress while preparing when only a completed (stale) preparation is in the transcript', () => {
    // Recycle re-prepare: prior non-no-op completed group remains rendered, but
    // the new running attempt is not merged yet — the row must stay visible.
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: false,
        hasStatusIndicator: true,
      })
    ).toBe('status');
  });

  it('keeps the status indicator on a non-preparing transcript that carries a preparation', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'ready',
        hasInProgressTranscriptPreparation: true,
        hasStatusIndicator: true,
      })
    ).toBe('status');
  });

  it('shows the reconnecting indicator while preparing', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
        statusIndicatorCode: 'reconnecting-to-agent',
        statusIndicatorType: 'progress',
        hasStatusIndicator: true,
      })
    ).toBe('status');
  });

  it('shows a classified error indicator while preparing', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
        statusIndicatorCode: 'insufficient-credits',
        statusIndicatorType: 'error',
        hasStatusIndicator: true,
      })
    ).toBe('status');
  });

  it('still hides a plain progress indicator while preparing', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        cloudStatusType: 'preparing',
        hasInProgressTranscriptPreparation: true,
        statusIndicatorCode: 'setting-up-environment',
        statusIndicatorType: 'progress',
        hasStatusIndicator: true,
      })
    ).toBeNull();
  });

  it('suppresses progress items on an empty transcript, where the body states its own', () => {
    expect(
      resolveSessionFooterRowItem({
        ...base,
        messageCount: 0,
        shouldShowFooterWorking: true,
      })
    ).toBeNull();
    expect(
      resolveSessionFooterRowItem({ ...base, messageCount: 0, hasStatusIndicator: true })
    ).toBeNull();
  });

  it('keeps the send reason on an empty transcript, where it is the reader only line', () => {
    // The failed load on an empty transcript is behind the full-screen Retry.
    // Inheriting the has-messages gate would delete the reason exactly when the
    // reader needs it.
    expect(
      resolveSessionFooterRowItem({
        ...base,
        messageCount: 0,
        hasStatusIndicator: true,
        hasSendReason: true,
      })
    ).toBe('reason');
  });
});
