import type { MessageDeliveryState, Part, StoredMessage } from '@kilocode/cloud-agent-sdk';
import { failedMessageRetryTarget } from './failed-message-retry';

function userRow(id: string, parts: Part[], synthetic = true): StoredMessage {
  return { info: { id, role: 'user', synthetic }, parts } as unknown as StoredMessage;
}

function assistantRow(id: string): StoredMessage {
  return { info: { id, role: 'assistant' }, parts: [] } as unknown as StoredMessage;
}

function text(value: string, extra: Record<string, unknown> = {}): Part {
  return { type: 'text', text: value, ...extra } as unknown as Part;
}

const failed: MessageDeliveryState = {
  status: 'failed',
  error: 'Workspace setup failed',
  reason: 'exhausted',
};

describe('failedMessageRetryTarget', () => {
  it('re-sends the prompt of the newest failed user row', () => {
    const messages = [
      userRow('m1', [text('first')]),
      assistantRow('a1'),
      userRow('m2', [text('fix the tests', { synthetic: true })]),
    ];

    expect(failedMessageRetryTarget(messages, new Map([['m2', failed]]))).toEqual({
      messageId: 'm2',
      prompt: 'fix the tests',
    });
  });

  it('ignores the server routing context part', () => {
    const messages = [
      userRow('m1', [
        text('<cloud-agent-context>repo</cloud-agent-context>', { synthetic: true }),
        text('fix the tests'),
      ]),
    ];

    expect(failedMessageRetryTarget(messages, new Map([['m1', failed]]))).toEqual({
      messageId: 'm1',
      prompt: 'fix the tests',
    });
  });

  it('offers nothing when a newer user row follows the failure', () => {
    const messages = [userRow('m1', [text('first')]), userRow('m2', [text('second')])];

    expect(failedMessageRetryTarget(messages, new Map([['m1', failed]]))).toBeNull();
  });

  it('offers nothing for a delivered row, which a re-send would show twice', () => {
    const messages = [userRow('m1', [text('first')], false)];

    expect(failedMessageRetryTarget(messages, new Map([['m1', failed]]))).toBeNull();
  });

  it('offers nothing for a user Stop', () => {
    const messages = [userRow('m1', [text('first')])];
    const interrupted: MessageDeliveryState = { ...failed, reason: 'interrupted' };

    expect(failedMessageRetryTarget(messages, new Map([['m1', interrupted]]))).toBeNull();
  });

  it('offers nothing for a queued or delivered row', () => {
    const messages = [userRow('m1', [text('first')])];

    expect(failedMessageRetryTarget(messages, new Map([['m1', { status: 'queued' }]]))).toBeNull();
    expect(failedMessageRetryTarget(messages, new Map())).toBeNull();
  });

  it('offers nothing when a text re-send would drop an attachment', () => {
    const messages = [
      userRow('m1', [
        text('describe this'),
        { type: 'file', mime: 'image/png', url: 'data:' } as unknown as Part,
      ]),
    ];

    expect(failedMessageRetryTarget(messages, new Map([['m1', failed]]))).toBeNull();
  });

  it('offers nothing for a row without prompt text', () => {
    const messages = [userRow('m1', [text('  ')])];

    expect(failedMessageRetryTarget(messages, new Map([['m1', failed]]))).toBeNull();
  });
});
