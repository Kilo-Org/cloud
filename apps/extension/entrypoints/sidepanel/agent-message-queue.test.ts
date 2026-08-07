import { describe, expect, it } from 'vitest';
import {
  appendQueuedMessage,
  resolveSendAction,
  shouldSendQueuedMessage,
} from './agent-message-queue';

describe('agent message queue', () => {
  it('appends to an empty queue', () => {
    expect(appendQueuedMessage(undefined, 'first')).toBe('first');
  });

  it('appends a second message after a blank line', () => {
    expect(appendQueuedMessage('first', 'second')).toBe('first\n\nsecond');
  });

  it('keeps the queue when the appended text is blank', () => {
    expect(appendQueuedMessage('first', '   ')).toBe('first');
  });

  it('trims the first message', () => {
    expect(appendQueuedMessage(undefined, '  spaced  ')).toBe('spaced');
  });

  it('sends the queued message when the run was not aborted', () => {
    expect(shouldSendQueuedMessage({ aborted: false, queued: 'go' })).toBe(true);
  });

  it('drops the queued message when the run was aborted', () => {
    expect(shouldSendQueuedMessage({ aborted: true, queued: 'go' })).toBe(false);
  });

  it('sends nothing when there is no queued message', () => {
    expect(shouldSendQueuedMessage({ aborted: false, queued: undefined })).toBe(false);
  });

  it('resolves to send when every precondition is met and no run is active', () => {
    expect(
      resolveSendAction({
        hasModel: true,
        hasTargetTab: true,
        isCompacting: false,
        isRunning: false,
        isStoreLoaded: true,
        text: 'go',
      })
    ).toBe('send');
  });

  it('resolves to queue when a run is active', () => {
    expect(
      resolveSendAction({
        hasModel: true,
        hasTargetTab: true,
        isCompacting: false,
        isRunning: true,
        isStoreLoaded: true,
        text: 'go',
      })
    ).toBe('queue');
  });

  it('ignores a submit that fails a precondition even during a run', () => {
    const validInput = {
      hasModel: true,
      hasTargetTab: true,
      isCompacting: false,
      isRunning: true,
      isStoreLoaded: true,
      text: 'go',
    };

    expect(
      resolveSendAction({
        ...validInput,
        isStoreLoaded: false,
      })
    ).toBe('ignore');
    expect(
      resolveSendAction({
        ...validInput,
        text: '   ',
      })
    ).toBe('ignore');
    expect(
      resolveSendAction({
        ...validInput,
        isCompacting: true,
      })
    ).toBe('ignore');
    expect(
      resolveSendAction({
        ...validInput,
        hasModel: false,
      })
    ).toBe('ignore');
    expect(
      resolveSendAction({
        ...validInput,
        hasTargetTab: false,
      })
    ).toBe('ignore');
  });
});
