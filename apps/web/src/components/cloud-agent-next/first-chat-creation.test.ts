import {
  createFirstChatCreationGuard,
  resolveFirstChatCreationAttempt,
  type FirstChatCreationAttempt,
} from './first-chat-creation';

describe('resolveFirstChatCreationAttempt', () => {
  let keyCounter = 0;
  let messageCounter = 0;
  const createOperationKey = () => `op-${++keyCounter}`;
  const createMessageId = () => `msg-${++messageCounter}`;

  beforeEach(() => {
    keyCounter = 0;
    messageCounter = 0;
  });

  it('mints a fresh operation key and message id for a new intent', () => {
    const attempt = resolveFirstChatCreationAttempt(
      null,
      'intent-a',
      createOperationKey,
      createMessageId
    );

    expect(attempt).toEqual({
      intent: 'intent-a',
      operationKey: 'op-1',
      initialMessageId: 'msg-1',
    });
  });

  it('reuses the operation key and message id when the intent is unchanged', () => {
    const first = resolveFirstChatCreationAttempt(
      null,
      'intent-a',
      createOperationKey,
      createMessageId
    );
    const retry = resolveFirstChatCreationAttempt(
      first,
      'intent-a',
      createOperationKey,
      createMessageId
    );

    expect(retry).toBe(first);
    expect(retry.operationKey).toBe('op-1');
    expect(retry.initialMessageId).toBe('msg-1');
  });

  it('starts a new attempt when the intent changes', () => {
    const first = resolveFirstChatCreationAttempt(
      null,
      'intent-a',
      createOperationKey,
      createMessageId
    );
    const edited = resolveFirstChatCreationAttempt(
      first,
      'intent-b',
      createOperationKey,
      createMessageId
    );

    expect(edited.intent).toBe('intent-b');
    expect(edited.operationKey).not.toBe(first.operationKey);
    expect(edited.initialMessageId).not.toBe(first.initialMessageId);
  });

  it('treats a missing current attempt as a new attempt', () => {
    const existing: FirstChatCreationAttempt = {
      intent: 'intent-a',
      operationKey: 'op-existing',
      initialMessageId: 'msg-existing',
    };

    const attempt = resolveFirstChatCreationAttempt(
      existing,
      'intent-a',
      createOperationKey,
      createMessageId
    );

    expect(attempt).toBe(existing);
  });
});

describe('createFirstChatCreationGuard', () => {
  it('admits only one holder until it is released', () => {
    const guard = createFirstChatCreationGuard();

    expect(guard.tryBegin()).toBe(true);
    expect(guard.tryBegin()).toBe(false);

    guard.end();
    expect(guard.tryBegin()).toBe(true);
  });
});
