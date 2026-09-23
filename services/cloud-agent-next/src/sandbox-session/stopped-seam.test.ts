import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoppedEvent } from '../sandbox-state/events.js';
import type {
  AcceptedMessageState,
  QueuedMessageState,
  SessionMessage,
} from '../sandbox-state/model/session.js';
import { decideStopped, settleStopped, type StoppedAttachment } from './stopped-seam.js';

const NOW = 1_000_000;
const INC = 'inc-1';

const ATTACHMENT: StoppedAttachment = {
  allocationIncarnation: INC,
  wrapperInstanceId: 'w-1',
};

const EVENT: StoppedEvent = {
  type: 'STOPPED',
  proof: {
    effect: 'destroy',
    at: NOW,
    providerRef: 'ref-1',
    incarnation: INC,
    reason: 'idle',
  },
  reason: 'allocation_stopped',
};

function queuedState(overrides: Partial<QueuedMessageState> = {}): QueuedMessageState {
  return {
    kind: 'queued',
    intent: null,
    legacyInvalidIntent: true,
    deliveryStep: 'waiting',
    deadlineAt: NOW + 1_000,
    attachFailures: 0,
    promptFailures: 0,
    wrapperInstanceId: 'w-1',
    preparationAttemptId: 'prep-1',
    preparationWait: { step: 'attach', message: 'waiting' },
    retryNotBefore: NOW,
    unresolvedDispatch: true,
    ...overrides,
  };
}

function queuedRow(messageId = 'm1', overrides: Partial<QueuedMessageState> = {}): SessionMessage {
  return {
    messageId,
    state: queuedState(overrides),
    cancellation: { operationId: 'cancel-1', deadlineAt: NOW + 10 },
  };
}

function acceptedState(overrides: Partial<AcceptedMessageState> = {}): AcceptedMessageState {
  return {
    kind: 'accepted',
    intent: null,
    legacyInvalidIntent: true,
    acceptedAt: NOW - 100,
    executionDeadlineAt: NOW + 1_000,
    lastActivityAt: NOW - 10,
    wrapperInstanceId: 'w-1',
    ...overrides,
  };
}

function acceptedRow(
  messageId = 'm2',
  overrides: Partial<AcceptedMessageState> = {}
): SessionMessage {
  return { messageId, state: acceptedState(overrides) };
}

const completedRow: SessionMessage = {
  messageId: 'm3',
  state: {
    kind: 'completed',
    intent: null,
    legacyInvalidIntent: true,
    at: NOW - 50,
    source: 'coordinator',
  },
};

/** The terminal union must not carry any delivery-only field. */
function terminalState(message: SessionMessage): Record<string, unknown> {
  return message.state as unknown as Record<string, unknown>;
}

describe('stopped seam — fenced decision', () => {
  it('terminalizes a queued-only bound session the row-derived binding would reject', () => {
    const result = decideStopped({
      messages: [queuedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    expect([...result.clear]).toEqual(['attachment', 'nativeRuntimeFence']);
    expect(result.messages[0]).toMatchObject({
      messageId: 'm1',
      state: {
        kind: 'failed',
        reason: 'allocation_stopped',
        at: NOW,
        source: 'coordinator',
      },
    });
    expect(terminalState(result.messages[0]!).wrapperInstanceId).toBeUndefined();
    // Allocation loss clears the sibling cancellation marker, exactly as HEAD's
    // stop projection did.
    expect(result.messages[0]!.cancellation).toBeUndefined();
  });

  it('terminalizes an accepted row and clears every delivery field', () => {
    const result = decideStopped({
      messages: [acceptedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    const state = terminalState(result.messages[0]!);
    expect(state.kind).toBe('failed');
    expect(state.reason).toBe('allocation_stopped');
    for (const field of [
      'wrapperInstanceId',
      'preparationAttemptId',
      'preparationWait',
      'retryNotBefore',
      'unresolvedDispatch',
    ]) {
      expect(state[field], field).toBeUndefined();
    }
  });

  it('terminalizes a terminal-only bound session without changing its messages', () => {
    const result = decideStopped({
      messages: [completedRow],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(result).toEqual({
      outcome: 'terminalized',
      messages: [completedRow],
      clear: ['attachment', 'nativeRuntimeFence'],
    });
  });

  it('terminalizes an empty-message bound session', () => {
    expect(decideStopped({ messages: [], attachment: ATTACHMENT, event: EVENT, now: NOW })).toEqual(
      {
        outcome: 'terminalized',
        messages: [],
        clear: ['attachment', 'nativeRuntimeFence'],
      }
    );
  });

  it('terminalizes once and rejects a replay after the attachment is cleared', () => {
    const first = decideStopped({
      messages: [queuedRow(), acceptedRow()],
      attachment: ATTACHMENT,
      event: EVENT,
      now: NOW,
    });
    expect(first.outcome).toBe('terminalized');
    if (first.outcome !== 'terminalized') return;
    expect(first.messages.map(message => message.state.kind)).toEqual(['failed', 'failed']);

    // The clearest binding is gone, so the replayed proof cannot terminalize
    // again; the already-terminal messages keep their first terminal timestamps.
    const replayed = decideStopped({
      messages: first.messages,
      attachment: undefined,
      event: EVENT,
      now: NOW + 5_000,
    });
    expect(replayed).toEqual({ outcome: 'rejected' });
    expect(first.messages.map(message => terminalState(message).at)).toEqual([NOW, NOW]);
  });

  it('does not terminalize fresh demand under an old proof, but a matching new proof does', () => {
    const freshRows = [queuedRow('fresh', { wrapperInstanceId: 'w-new' })];
    const freshAttachment: StoppedAttachment = {
      allocationIncarnation: 'inc-new',
      wrapperInstanceId: 'w-new',
    };
    const stale: StoppedEvent = {
      ...EVENT,
      proof: { ...EVENT.proof, incarnation: 'inc-old' },
    };
    expect(
      decideStopped({ messages: freshRows, attachment: freshAttachment, event: stale, now: NOW })
    ).toEqual({ outcome: 'rejected' });

    const matching: StoppedEvent = {
      ...EVENT,
      proof: { ...EVENT.proof, incarnation: 'inc-new', wrapper: 'w-new' },
    };
    const result = decideStopped({
      messages: freshRows,
      attachment: freshAttachment,
      event: matching,
      now: NOW,
    });
    expect(result.outcome).toBe('terminalized');
    if (result.outcome !== 'terminalized') return;
    expect(result.messages[0]).toMatchObject({ messageId: 'fresh', state: { kind: 'failed' } });
  });

  it('rejects a stale incarnation', () => {
    expect(
      decideStopped({
        messages: [queuedRow()],
        attachment: { allocationIncarnation: 'inc-2', wrapperInstanceId: 'w-1' },
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
  });

  it('rejects a mismatched proof wrapper', () => {
    const stale: StoppedEvent = { ...EVENT, proof: { ...EVENT.proof, wrapper: 'w-9' } };
    expect(
      decideStopped({ messages: [queuedRow()], attachment: ATTACHMENT, event: stale, now: NOW })
    ).toEqual({ outcome: 'rejected' });
  });

  it('rejects an unfenceable record without an incarnation', () => {
    const noIncarnation: StoppedAttachment = { wrapperInstanceId: 'w-1' };
    expect(
      decideStopped({
        messages: [acceptedRow()],
        attachment: noIncarnation,
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
    expect(
      decideStopped({
        messages: [completedRow],
        attachment: noIncarnation,
        event: EVENT,
        now: NOW,
      })
    ).toEqual({ outcome: 'rejected' });
  });
});

describe('stopped seam — proof-independent settlement', () => {
  it('terminalizes queued and accepted messages without a fence', () => {
    const result = settleStopped({
      messages: [queuedRow(), acceptedRow(), completedRow],
      reason: 'lost',
      now: NOW,
    });
    expect(result.outcome).toBe('settled');
    if (result.outcome !== 'settled') return;
    expect([...result.clear]).toEqual(['attachment', 'nativeRuntimeFence']);
    expect(result.messages.map(message => message.state.kind)).toEqual([
      'failed',
      'failed',
      'completed',
    ]);
    const first = terminalState(result.messages[0]!);
    const second = terminalState(result.messages[1]!);
    expect(first.reason).toBe('lost');
    expect(second.reason).toBe('lost');
  });
});

describe('stopped seam — quarantine', () => {
  it('never imports the legacy decoder directly', () => {
    const source = readFileSync(join(__dirname, 'stopped-seam.ts'), 'utf-8');
    expect(source).not.toMatch(/from\s+['"][^'"]*persist\/legacy/);
  });
});
