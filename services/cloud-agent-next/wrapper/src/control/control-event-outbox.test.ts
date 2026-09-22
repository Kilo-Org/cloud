import { afterEach, beforeEach, describe, expect, it, jest, mock, spyOn } from 'bun:test';
import { ControlDeliveryError } from './sandbox-control-client';
import {
  CONTROL_EVENT_BATCH_WINDOW_MS,
  MAX_CONTROL_EVENT_OUTBOX_EVENTS,
  createControlEventOutbox,
  type ControlEventOutboxFailure,
  type ControlEventPublication,
  type PreparedControlEventPublication,
} from './control-event-outbox';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sandboxEventPublicationPayloadSchema,
} from '../../../src/shared/sandbox-control-protocol';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};

function messageUpdatedPayload(id: string, marker: string, sessionID = session.kiloSessionId) {
  return {
    type: 'message.updated',
    properties: { info: { id, sessionID, role: 'assistant', marker } },
  };
}

function partUpdatedPayload(
  messageID: string,
  id: string,
  marker: string,
  sessionID = session.kiloSessionId
) {
  return {
    type: 'message.part.updated',
    properties: {
      part: { id, messageID, sessionID, type: 'text', text: marker },
    },
  };
}

function deltaPayload(
  messageID: string,
  id: string,
  delta: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    type: 'message.part.delta',
    properties: {
      sessionID: session.kiloSessionId,
      messageID,
      partID: id,
      field: 'text',
      delta,
      ...overrides,
    },
  };
}

function deltaText(payload: unknown): string {
  const delta = (payload as { properties?: { delta?: unknown } } | undefined)?.properties?.delta;
  if (typeof delta !== 'string') throw new Error('expected a string delta');
  return delta;
}

async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error('Timed out waiting for outbox publication');
}

describe('control event outbox', () => {
  it('releases a root lane after local handoff without waiting for a receipt', async () => {
    const delivered: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
      },
      onFailure: mock(),
    });
    try {
      for (let sequence = 0; sequence < 3; sequence += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: { type: 'session.idle', properties: { sequence } },
            })
          )
        ).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(delivered.map(publication => publication.sequence)).toEqual([1, 2, 3]);
    } finally {
      outbox.close();
    }
  });

  it('applies count pressure across roots and drops the incoming publication', () => {
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async () => {},
      onFailure: failure,
    });
    try {
      for (let index = 0; index < MAX_CONTROL_EVENT_OUTBOX_EVENTS; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session: {
                ...session,
                kiloSessionId: `ses_${index}`,
                rootKiloSessionId: `ses_${index}`,
              },
              payload: { type: 'session.idle', properties: { index } },
            })
          )
        ).toBe(true);
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: {
              ...session,
              kiloSessionId: 'ses_overflow',
              rootKiloSessionId: 'ses_overflow',
            },
            payload: {
              type: 'session.idle',
              properties: { index: MAX_CONTROL_EVENT_OUTBOX_EVENTS },
            },
          })
        )
      ).toBe(false);
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'queue_overflow' }));
    } finally {
      outbox.close();
    }
  });

  it('squashes adjacent same-part updates while retaining the original receipt metadata', async () => {
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
      },
      onFailure: mock(),
    });
    try {
      const barrier = outbox.prepare({
        event: 'session.event',
        session,
        payload: { type: 'session.idle', properties: {} },
      });
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'first'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'latest'),
      });
      expect(outbox.enqueue(barrier)).toBe(true);
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);

      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(delivered.map(item => item.publication.sequence)).toEqual([1, 2]);
      expect(delivered[0]?.publication.payload).toEqual(barrier.payload);
      expect(delivered[1]?.publication).toMatchObject({
        receiptId: first.receiptId,
        sequence: first.sequence,
        payload: second.payload,
      });
      expect(delivered[1]?.deadlineAt).toBe(first.deadlineAt);
    } finally {
      outbox.close();
    }
  });

  it('recomputes retained bytes from the retained sequence width', async () => {
    let failed: PreparedControlEventPublication | undefined;
    let publishCount = 0;
    const outbox = createControlEventOutbox({
      publish: async () => {
        publishCount += 1;
        if (publishCount === 9) throw new ControlDeliveryError('rejected', false);
      },
      onFailure: failure => {
        failed = failure.publication as PreparedControlEventPublication;
      },
    });
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: {
                type: 'message.created',
                properties: { messageId: `barrier_${index}` },
              },
            })
          )
        ).toBe(true);
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'first'),
      });
      const latest = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'latest'),
      });
      expect(first.sequence).toBe(9);
      expect(latest.sequence).toBe(10);
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(latest)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      const retained = failed;
      if (!retained) throw new Error('Missing retained publication');
      const bytes = retained.bytes;
      const wire: ControlEventPublication & { bytes?: number; deadlineAt?: number } = {
        ...retained,
      };
      delete wire.bytes;
      delete wire.deadlineAt;
      expect(bytes).toBe(
        Buffer.byteLength(
          JSON.stringify({
            type: 'request',
            requestId: 'event_00000000-0000-4000-8000-000000000000',
            operation: 'sandbox.event.publish',
            payload: wire,
          })
        )
      );
      expect(bytes).not.toBe(latest.bytes);
    } finally {
      outbox.close();
    }
  });

  it('squashes adjacent same-message updates to the latest payload', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'first'),
      });
      clock.mockReturnValue(2_000);
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'latest'),
      });
      expect(first.deadlineAt).toBe(61_000);
      expect(second.deadlineAt).toBe(62_000);
      expect(first.deadlineAt).toBeLessThan(second.deadlineAt);
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);

      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.publication).toMatchObject({
        receiptId: first.receiptId,
        sequence: first.sequence,
        payload: second.payload,
      });
      expect(delivered[0]?.deadlineAt).toBe(first.deadlineAt);
    } finally {
      outbox.close();
      clock.mockRestore();
    }
  });

  it('keeps an in-flight head unchanged while squashing an unsent tail', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'in flight'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_2', 'queued'),
      });
      const latest = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_2', 'latest'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      const draining = outbox.resume();
      await started.promise;
      expect(outbox.enqueue(latest)).toBe(true);
      release.resolve();

      expect(await draining).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toMatchObject({
        publication: {
          receiptId: first.receiptId,
          sequence: first.sequence,
          payload: first.payload,
        },
        deadlineAt: first.deadlineAt,
      });
      expect(delivered[1]).toMatchObject({
        publication: {
          receiptId: second.receiptId,
          sequence: second.sequence,
          payload: latest.payload,
        },
        deadlineAt: second.deadlineAt,
      });
    } finally {
      release.resolve();
      outbox.close();
    }
  });

  it('does not squash a newer update into a single in-flight publication', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'first'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'latest'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      const draining = outbox.resume();
      await started.promise;
      expect(outbox.enqueue(second)).toBe(true);
      release.resolve();

      expect(await draining).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(delivered[0]).toMatchObject({
        publication: {
          receiptId: first.receiptId,
          sequence: first.sequence,
          payload: first.payload,
        },
        deadlineAt: first.deadlineAt,
      });
      expect(delivered[1]).toMatchObject({
        publication: {
          receiptId: second.receiptId,
          sequence: second.sequence,
          payload: second.payload,
        },
        deadlineAt: second.deadlineAt,
      });
      expect(first.receiptId).not.toBe(second.receiptId);
      expect(first.sequence).not.toBe(second.sequence);
    } finally {
      release.resolve();
      outbox.close();
    }
  });

  it('squashes the new head after the prior head is removed before its attempt settles', async () => {
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    let replacement: PreparedControlEventPublication | undefined = undefined;
    let replacementAdmitted = false;
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) {
          throw new ControlDeliveryError('permanent failure', false);
        }
      },
      onFailure: failure => {
        if (failure.reason === 'rejected' && replacement !== undefined)
          replacementAdmitted = outbox.enqueue(replacement);
      },
    });
    const preparedFirst = outbox.prepare({
      event: 'session.event',
      session,
      payload: messageUpdatedPayload('msg_1', 'failed'),
    });
    const preparedSecond = outbox.prepare({
      event: 'session.event',
      session,
      payload: messageUpdatedPayload('msg_2', 'queued'),
    });
    const preparedLatest = outbox.prepare({
      event: 'session.event',
      session,
      payload: messageUpdatedPayload('msg_2', 'latest'),
    });
    replacement = preparedLatest;
    try {
      expect(outbox.enqueue(preparedFirst)).toBe(true);
      expect(outbox.enqueue(preparedSecond)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(replacementAdmitted).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]).toMatchObject({
        publication: {
          receiptId: preparedSecond.receiptId,
          sequence: preparedSecond.sequence,
          payload: preparedLatest.payload,
        },
        deadlineAt: preparedSecond.deadlineAt,
      });
    } finally {
      outbox.close();
    }
  });

  it('does not squash across a message and part entity barrier', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'message before'),
      });
      const barrier = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'part barrier'),
      });
      const last = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'message after'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(barrier)).toBe(true);
      expect(outbox.enqueue(last)).toBe(true);

      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(3);
      expect(published.map(item => item.sequence)).toEqual([1, 2, 3]);
      expect(published.map(item => item.payload)).toEqual([
        first.payload,
        barrier.payload,
        last.payload,
      ]);
    } finally {
      outbox.close();
    }
  });

  it.each(['entity', 'root', 'native', 'session', 'directory'] as const)(
    'does not squash when the %s is different',
    async fence => {
      const published: ControlEventPublication[] = [];
      const outbox = createControlEventOutbox({
        publish: async publication => {
          published.push(publication);
        },
        onFailure: mock(),
      });
      const firstNativeRuntimeId = crypto.randomUUID();
      const secondNativeRuntimeId = crypto.randomUUID();
      const firstSession =
        fence === 'root'
          ? { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' }
          : fence === 'session'
            ? { ...session, kiloSessionId: 'child_a', rootKiloSessionId: 'root_shared' }
            : fence === 'directory'
              ? { ...session, directory: '/workspace/a' }
              : { ...session, nativeRuntimeId: firstNativeRuntimeId };
      const secondSession =
        fence === 'root'
          ? { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' }
          : fence === 'session'
            ? { ...session, kiloSessionId: 'child_b', rootKiloSessionId: 'root_shared' }
            : fence === 'directory'
              ? { ...session, directory: '/workspace/b' }
              : fence === 'native'
                ? { ...session, nativeRuntimeId: secondNativeRuntimeId }
                : firstSession;
      const first = outbox.prepare({
        event: 'session.event',
        session: firstSession,
        payload: messageUpdatedPayload('msg_1', 'first', firstSession.kiloSessionId),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session: secondSession,
        payload: messageUpdatedPayload(
          fence === 'entity' ? 'msg_2' : 'msg_1',
          'second',
          secondSession.kiloSessionId
        ),
      });
      try {
        expect(outbox.enqueue(first)).toBe(true);
        expect(outbox.enqueue(second)).toBe(true);
        expect(await outbox.resume()).toBe(true);
        expect(published).toHaveLength(2);
        expect(published.map(item => item.payload)).toEqual([first.payload, second.payload]);
      } finally {
        outbox.close();
      }
    }
  );

  it.each([
    [
      'outcome',
      'session.event',
      { type: 'session.message.outcome', properties: { messageId: 'msg_1', status: 'completed' } },
    ],
    [
      'removed',
      'session.event',
      { type: 'message.removed', properties: { sessionID: 'ses_root', messageID: 'msg_1' } },
    ],
    [
      'lifecycle',
      'session.event',
      { type: 'session.updated', properties: { info: { id: 'ses_root' } } },
    ],
    [
      'preparing',
      'session.preparing',
      {
        version: 2,
        attemptId: 'attempt_1',
        triggerMessageId: 'msg_1',
        revision: 0,
        timestamp: 1,
        step: 'started',
        message: 'preparing',
        action: 'start',
      },
    ],
    [
      'non-entity',
      'session.event',
      { type: 'session.status', properties: { sessionID: 'ses_root' } },
    ],
  ] as const)('does not squash across a %s barrier', async (_name, event, payload) => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'before'),
      });
      const barrier = outbox.prepare({ event, session, payload });
      const last = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'after'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(barrier)).toBe(true);
      expect(outbox.enqueue(last)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(3);
      expect(published.map(item => item.sequence)).toEqual([1, 2, 3]);
    } finally {
      outbox.close();
    }
  });

  it('reports a failed local handoff once and delivers a newer same-message update behind it', async () => {
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) throw new ControlDeliveryError('not attached', true);
      },
      onFailure: failure,
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'first'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_1', 'latest'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(failure).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'rejected', publication: first })
      );
      expect(delivered).toHaveLength(2);
      expect(delivered[1]?.publication).toMatchObject({
        receiptId: second.receiptId,
        sequence: second.sequence,
        payload: second.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it('uses post-replacement bytes to admit a smaller adjacent update', async () => {
    const delivered: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
      },
      onFailure: mock(),
    });
    const filler = 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45));
    const oldText = 'o'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.35));
    const smallerText = 's'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.3));
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: messageUpdatedPayload(`filler_${index}`, filler),
            })
          )
        ).toBe(true);
      const old = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', oldText),
      });
      const smaller = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', smallerText),
      });
      expect(smaller.bytes).toBeLessThan(old.bytes);
      expect(outbox.enqueue(old)).toBe(true);
      expect(outbox.enqueue(smaller)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(9);
      expect(delivered.at(-1)).toMatchObject({
        receiptId: old.receiptId,
        sequence: old.sequence,
        payload: smaller.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it('rejects a larger adjacent replacement without mutating the old payload', async () => {
    const delivered: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
      },
      onFailure: mock(),
    });
    const filler = 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45));
    const largerText = 'l'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.7));
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: messageUpdatedPayload(`filler_${index}`, filler),
            })
          )
        ).toBe(true);
      const old = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', 'old'),
      });
      const larger = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', largerText),
      });
      expect(larger.bytes).toBeGreaterThan(old.bytes);
      expect(outbox.enqueue(old)).toBe(true);
      expect(outbox.enqueue(larger)).toBe(false);
      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(9);
      expect(delivered.at(-1)).toMatchObject({
        receiptId: old.receiptId,
        sequence: old.sequence,
        payload: old.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it(`admits a tail replacement at the ${MAX_CONTROL_EVENT_OUTBOX_EVENTS}-entry count boundary`, async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < MAX_CONTROL_EVENT_OUTBOX_EVENTS - 1; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: { type: 'session.idle', properties: {} },
            })
          )
        ).toBe(true);
      const old = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', 'old'),
      });
      const latest = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', 'latest'),
      });
      expect(outbox.enqueue(old)).toBe(true);
      expect(outbox.enqueue(latest)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(MAX_CONTROL_EVENT_OUTBOX_EVENTS);
      expect(published.at(-1)).toMatchObject({
        receiptId: old.receiptId,
        sequence: old.sequence,
        payload: latest.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it('reports a root A handoff failure without delaying root B', async () => {
    const published: ControlEventPublication[] = [];
    let attemptsA = 0;
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
        const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
        if (root === 'root_a' && attemptsA++ === 0)
          throw new ControlDeliveryError('root A is not attached', true);
      },
      onFailure: failure,
    });
    try {
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' },
          payload: { type: 'session.idle', properties: {} },
        })
      );
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' },
          payload: { type: 'session.idle', properties: {} },
        })
      );

      expect(await outbox.resume()).toBe(true);
      expect(
        published.map(item => item.session.rootKiloSessionId ?? item.session.kiloSessionId)
      ).toEqual(['root_a', 'root_b']);
      expect(failure).toHaveBeenCalledTimes(1);
      const reported = failure.mock.calls[0]?.[0] as
        | { reason?: string; publication?: ControlEventPublication }
        | undefined;
      expect(reported?.reason).toBe('rejected');
      expect(reported?.publication?.receiptId).toBe(published[0]?.receiptId);
    } finally {
      outbox.close();
    }
  });

  it('wakes an active cycle when a new root is admitted during a pending receipt', async () => {
    const startedA = Promise.withResolvers<void>();
    const releaseA = Promise.withResolvers<void>();
    const rootA = { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' };
    const rootB = { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' };
    let releasedA = false;
    let startedB = false;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
        if (root === 'root_a') {
          startedA.resolve();
          await releaseA.promise;
        } else {
          startedB = true;
        }
      },
      onFailure: mock(),
    });
    try {
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: rootA,
          payload: { type: 'session.idle' },
        })
      );
      const draining = outbox.resume();
      await startedA.promise;
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: rootB,
            payload: { type: 'session.idle' },
          })
        )
      ).toBe(true);
      await waitFor(() => startedB);
      expect(releasedA).toBe(false);
      releasedA = true;
      releaseA.resolve();
      expect(await draining).toBe(true);
    } finally {
      releaseA.resolve();
      outbox.close();
    }
  });

  it('applies byte pressure across roots and drops the incoming publication', () => {
    const failure = mock();
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: failure });
    const medium = {
      type: 'message.updated',
      properties: { text: 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45)) },
    };
    try {
      let admitted = 0;
      for (;;) {
        const publication = outbox.prepare({
          event: 'session.event',
          session: {
            ...session,
            kiloSessionId: `ses_${admitted}`,
            rootKiloSessionId: `ses_${admitted}`,
          },
          payload: medium,
        });
        if (!outbox.enqueue(publication)) break;
        admitted += 1;
        if (admitted > MAX_CONTROL_EVENT_OUTBOX_EVENTS)
          throw new Error('byte budget did not apply');
      }
      expect(admitted).toBeGreaterThan(1);
      expect(admitted).toBeLessThan(MAX_CONTROL_EVENT_OUTBOX_EVENTS);
      expect(failure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'queue_overflow' }));
    } finally {
      outbox.close();
    }
  });

  it('sends roots fairly while keeping one publication in flight per root', async () => {
    const started: ControlEventPublication[] = [];
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const releases = new Map<string, PromiseWithResolvers<void>>();
    const outbox = createControlEventOutbox({
      publish: async publication => {
        const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
        if (!root) throw new Error('Missing root');
        const count = (active.get(root) ?? 0) + 1;
        active.set(root, count);
        maximum.set(root, Math.max(maximum.get(root) ?? 0, count));
        started.push(publication);
        const release = Promise.withResolvers<void>();
        releases.set(`${root}:${publication.sequence}`, release);
        await release.promise;
        active.set(root, count - 1);
      },
      onFailure: mock(),
    });
    const rootA = { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' };
    const rootB = { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' };
    try {
      for (const [root, count] of [
        [rootA, 2],
        [rootB, 2],
      ] as const)
        for (let index = 0; index < count; index += 1)
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session: root,
              payload: { type: 'session.idle', properties: {} },
            })
          );

      const draining = outbox.resume();
      await waitFor(() => started.length === 2);
      expect(started.map(item => item.session.rootKiloSessionId)).toEqual(['root_a', 'root_b']);
      expect(maximum).toEqual(
        new Map([
          ['root_a', 1],
          ['root_b', 1],
        ])
      );

      releases.get('root_a:1')?.resolve();
      await waitFor(() => started.length === 3);
      expect(started[2]?.session.rootKiloSessionId).toBe('root_a');
      expect(maximum.get('root_a')).toBe(1);
      expect(maximum.get('root_b')).toBe(1);

      releases.get('root_b:3')?.resolve();
      await waitFor(() => started.length === 4);
      expect(started[3]?.session.rootKiloSessionId).toBe('root_b');
      releases.get('root_a:2')?.resolve();
      releases.get('root_b:4')?.resolve();
      expect(await draining).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('keeps root and child publications in one FIFO lane', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const child = { ...session, kiloSessionId: 'ses_child' };
      const sibling = {
        ...session,
        kiloSessionId: 'ses_sibling',
        rootKiloSessionId: 'ses_sibling',
      };
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: session,
          payload: { type: 'session.idle', properties: {} },
        })
      );
      outbox.enqueue(
        outbox.prepare({
          event: 'session.preparing',
          session: child,
          payload: { action: 'step_started' },
        })
      );
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: sibling,
          payload: { type: 'session.idle', properties: {} },
        })
      );
      expect(await outbox.resume()).toBe(true);
      const rootPublished = published.filter(
        item => (item.session.rootKiloSessionId ?? item.session.kiloSessionId) === 'ses_root'
      );
      expect(rootPublished.map(item => item.session.kiloSessionId)).toEqual([
        'ses_root',
        'ses_child',
      ]);
      expect(rootPublished.map(item => item.sequence)).toEqual([1, 2]);
    } finally {
      outbox.close();
    }
  });

  it('snapshots native lifetime before replacement', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    const nativeRuntimeId = crypto.randomUUID();
    const identity = { ...session, nativeRuntimeId };
    const payload = { type: 'session.status', properties: { status: { type: 'idle' } } };
    const first = outbox.prepare({ event: 'session.event', session: identity, payload });
    expect(outbox.enqueue(first)).toBe(true);
    identity.nativeRuntimeId = crypto.randomUUID();
    expect(
      outbox.enqueue(outbox.prepare({ event: 'session.event', session: identity, payload }))
    ).toBe(true);
    expect(await outbox.resume()).toBe(true);
    expect(published.map(item => item.session.nativeRuntimeId)).toEqual([
      nativeRuntimeId,
      identity.nativeRuntimeId,
    ]);
    const { bytes, deadlineAt, ...wire } = first;
    expect(bytes).toBeGreaterThan(0);
    expect(deadlineAt).toBeGreaterThan(Date.now());
    const parsed = sandboxEventPublicationPayloadSchema.parse(wire);
    expect(wire).toEqual(parsed);
    expect(wire).toEqual(expect.objectContaining({ receiptId: first.receiptId, sequence: 1 }));
    expect(wire).not.toHaveProperty('receiptHash');
    expect(
      sandboxEventPublicationPayloadSchema.safeParse({
        ...wire,
        session: { ...session, nativeRuntimeId: 'invalid' },
      }).success
    ).toBe(false);
    expect(() =>
      outbox.prepare({
        event: 'session.event',
        session: { ...session, nativeRuntimeId: 'invalid' },
        payload,
      })
    ).toThrow();
  });

  it('keeps receipt publications without native identity wire-compatible', () => {
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
    const publication = outbox.prepare({
      event: 'session.event',
      session,
      payload: { type: 'session.idle', properties: {} },
    });
    const { bytes, deadlineAt, ...wire } = publication;
    expect(bytes).toBeGreaterThan(0);
    expect(deadlineAt).toBeGreaterThan(Date.now());
    expect(wire).toEqual(sandboxEventPublicationPayloadSchema.parse(wire));
    expect(wire.session).toEqual(session);
    expect(wire).not.toHaveProperty('receiptHash');
  });

  it('coalesces publication callbacks that synchronously enqueue and resume', async () => {
    const published: number[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication.sequence);
        if (published.length !== 1) return;
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: { type: 'session.idle' },
            })
          )
        ).toBe(true);
        void outbox.resume();
      },
      onFailure: mock(),
    });
    try {
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session,
          payload: { type: 'session.idle' },
        })
      );
      expect(await outbox.resume()).toBe(true);
      expect(published).toEqual([1, 2]);
    } finally {
      outbox.close();
    }
  });

  it('does not publish a deferred attempt after immediate close', async () => {
    const published = mock(async () => {});
    const outbox = createControlEventOutbox({ publish: published, onFailure: mock() });
    outbox.enqueue(
      outbox.prepare({ event: 'session.event', session, payload: { type: 'session.idle' } })
    );
    const draining = outbox.resume();
    outbox.close();
    expect(await draining).toBe(false);
    expect(published).not.toHaveBeenCalled();
  });

  it('does not publish a deferred attempt after immediate pause', async () => {
    const published = mock(async () => {});
    const outbox = createControlEventOutbox({ publish: published, onFailure: mock() });
    try {
      outbox.enqueue(
        outbox.prepare({ event: 'session.event', session, payload: { type: 'session.idle' } })
      );
      const pumping = outbox.resume();
      outbox.pause();
      expect(await pumping).toBe(false);
      expect(published).not.toHaveBeenCalled();
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveBeenCalledTimes(1);
    } finally {
      outbox.close();
    }
  });

  it('wakes a pending cycle when paused without starting another lane', async () => {
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const published = mock(async (publication: ControlEventPublication) => {
      if (
        typeof publication.payload === 'object' &&
        publication.payload !== null &&
        'type' in publication.payload &&
        publication.payload.type === 'first'
      )
        started.resolve();
      await held.promise;
    });
    const outbox = createControlEventOutbox({ publish: published, onFailure: mock() });
    try {
      outbox.enqueue(
        outbox.prepare({ event: 'session.event', session, payload: { type: 'first' } })
      );
      const pumping = outbox.resume();
      await started.promise;
      outbox.pause();
      expect(await pumping).toBe(false);
      outbox.enqueue(
        outbox.prepare({ event: 'session.event', session, payload: { type: 'second' } })
      );
      expect(published).toHaveBeenCalledTimes(1);
      const resumed = outbox.resume();
      held.resolve();
      expect(await resumed).toBe(true);
      expect(published).toHaveBeenCalledTimes(2);
    } finally {
      held.resolve();
      outbox.close();
    }
  });

  it('settles an in-flight pump on close without publishing queued events', async () => {
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const failure = mock();
    const published = mock(() => {
      started.resolve();
      return held.promise;
    });
    const outbox = createControlEventOutbox({ publish: published, onFailure: failure });
    for (let index = 0; index < 2; index += 1)
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session,
          payload: { type: 'session.idle' },
        })
      );
    const pumping = outbox.resume();
    await started.promise;
    outbox.close();
    expect(await pumping).toBe(false);
    held.reject(new ControlDeliveryError('late connection close', true));
    await Promise.resolve();
    expect(published).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ reason: 'disconnected' }));
    expect(await outbox.resume()).toBe(false);
  });

  it.each(['paused', 'pending'] as const)(
    'expires an old native publication at its original deadline while %s and admits its replacement',
    async phase => {
      const clock = spyOn(Date, 'now').mockReturnValue(1_000);
      const timers = spyOn(globalThis, 'setTimeout');
      const failure = mock();
      const held = Promise.withResolvers<void>();
      const published: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
      const nativeRuntimeId = crypto.randomUUID();
      const replacementId = crypto.randomUUID();
      const outbox = createControlEventOutbox({
        publish: async (publication, deadlineAt) => {
          published.push({ publication, deadlineAt });
          if (publication.session.nativeRuntimeId !== nativeRuntimeId) return;
          if (phase === 'pending') return held.promise;
          throw new ControlDeliveryError('not attached', true);
        },
        onFailure: failure,
      });
      try {
        const original = outbox.prepare({
          event: 'session.event',
          session: { ...session, nativeRuntimeId },
          payload: { type: 'session.idle' },
        });
        expect(original.deadlineAt).toBe(61_000);
        outbox.enqueue(original);
        clock.mockReturnValue(60_900);
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: { ...session, nativeRuntimeId: replacementId },
            payload: { type: 'session.idle' },
          })
        );
        const pumping = phase === 'paused' ? undefined : outbox.resume();
        await Promise.resolve();
        expect(timers.mock.calls.at(-1)?.[1]).toBe(100);
        const expire = timers.mock.calls.at(-1)?.[0];
        if (typeof expire !== 'function') throw new Error('Missing publication deadline');
        clock.mockReturnValue(original.deadlineAt);
        clearTimeout(
          timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined
        );
        expire();
        await pumping;
        expect(await outbox.resume()).toBe(true);
        expect(failure).toHaveBeenCalledTimes(1);
        const reported = failure.mock.calls[0]?.[0] as
          | { reason?: string; publication?: ControlEventPublication }
          | undefined;
        expect(reported?.reason).toBe('expired');
        expect(reported?.publication?.receiptId).toBe(original.receiptId);
        expect(published.at(-1)?.publication.session.nativeRuntimeId).toBe(replacementId);
        expect(
          published.filter(item => item.publication.session.nativeRuntimeId === nativeRuntimeId)
        ).toHaveLength(phase === 'paused' ? 0 : 1);
        if (phase === 'pending') {
          const unhandled: unknown[] = [];
          const onUnhandled = (reason: unknown) => {
            unhandled.push(reason);
          };
          process.on('unhandledRejection', onUnhandled);
          try {
            held.reject(new ControlDeliveryError('late old publication failure', false));
            await Promise.resolve();
            expect(unhandled).toEqual([]);
          } finally {
            process.off('unhandledRejection', onUnhandled);
          }
        }
        await Promise.resolve();
        expect(failure).toHaveBeenCalledTimes(1);
      } finally {
        held.resolve();
        outbox.close();
        timers.mockRestore();
        clock.mockRestore();
      }
    }
  );

  it('retains an immutable event snapshot across a sustained offline burst', async () => {
    const published: Array<{ payload: { properties: { nested: { state: string } } } }> = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication as (typeof published)[number]);
      },
      onFailure: mock(),
    });
    const payload = { type: 'message.updated', properties: { nested: { state: 'queued' } } };
    expect(outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload }))).toBe(true);
    payload.properties.nested.state = 'mutated';
    for (let index = 0; index < 96; index += 1)
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session,
            payload: { type: 'message.updated', properties: { id: `burst_${index}` } },
          })
        )
      ).toBe(true);

    expect(await outbox.resume()).toBe(true);
    expect(published).toHaveLength(97);
    expect(published[0]?.payload.properties.nested.state).toBe('queued');
  });
});

describe('control event outbox delta merge', () => {
  async function flushMicrotasks(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
  }

  it('merges adjacent same-part text deltas while retaining the original receipt metadata', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'Hello '),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'world'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        receiptId: first.receiptId,
        sequence: first.sequence,
      });
      expect(published[0]?.payload).toEqual(deltaPayload('msg_1', 'part_1', 'Hello world'));
    } finally {
      outbox.close();
    }
  });

  it.each([
    ['message', deltaPayload('msg_1', 'part_1', 'a'), deltaPayload('msg_2', 'part_1', 'b')],
    ['part', deltaPayload('msg_1', 'part_1', 'a'), deltaPayload('msg_1', 'part_2', 'b')],
    [
      'field',
      deltaPayload('msg_1', 'part_1', 'a'),
      deltaPayload('msg_1', 'part_1', 'b', { field: 'reasoning' }),
    ],
  ] as const)(
    'does not merge adjacent deltas with a different %s',
    async (_name, first, second) => {
      const published: ControlEventPublication[] = [];
      const outbox = createControlEventOutbox({
        publish: async publication => {
          published.push(publication);
        },
        onFailure: mock(),
      });
      try {
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: first }))
        ).toBe(true);
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: second }))
        ).toBe(true);
        expect(await outbox.resume()).toBe(true);
        expect(published).toHaveLength(2);
        expect(published.map(item => item.payload)).toEqual([first, second]);
      } finally {
        outbox.close();
      }
    }
  );

  it('keeps a delta on either side of a snapshot barrier as its own publication', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const head = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      const barrier = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'snapshot'),
      });
      const tail = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'b'),
      });
      expect(outbox.enqueue(head)).toBe(true);
      expect(outbox.enqueue(barrier)).toBe(true);
      expect(outbox.enqueue(tail)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published.map(item => item.payload)).toEqual([
        head.payload,
        barrier.payload,
        tail.payload,
      ]);
    } finally {
      outbox.close();
    }
  });

  it('does not merge a delta into a snapshot tail', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const snapshot = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'snapshot'),
      });
      const delta = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      expect(outbox.enqueue(snapshot)).toBe(true);
      expect(outbox.enqueue(delta)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published.map(item => item.payload)).toEqual([snapshot.payload, delta.payload]);
    } finally {
      outbox.close();
    }
  });

  it('does not merge deltas from different session identities on a shared root lane', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    const childA = { ...session, kiloSessionId: 'child_a', rootKiloSessionId: 'root_shared' };
    const childB = { ...session, kiloSessionId: 'child_b', rootKiloSessionId: 'root_shared' };
    try {
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: childA,
            payload: deltaPayload('msg_1', 'part_1', 'a'),
          })
        )
      ).toBe(true);
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: childB,
            payload: deltaPayload('msg_1', 'part_1', 'b'),
          })
        )
      ).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(2);
    } finally {
      outbox.close();
    }
  });

  it.each([
    [
      'a non-string delta',
      deltaPayload('msg_1', 'part_1', 'a'),
      deltaPayload('msg_1', 'part_1', 'b', { delta: 123 }),
    ],
    [
      'a differing non-delta property',
      deltaPayload('msg_1', 'part_1', 'a', { partType: 'text' }),
      deltaPayload('msg_1', 'part_1', 'b', { partType: 'tool' }),
    ],
  ] as const)('does not merge deltas with %s', async (_name, first, second) => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      expect(
        outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: first }))
      ).toBe(true);
      expect(
        outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: second }))
      ).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(2);
    } finally {
      outbox.close();
    }
  });

  it('coalesces a paused same-part delta burst within the entry bound', async () => {
    const published: ControlEventPublication[] = [];
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: failure,
    });
    const chunks = Array.from({ length: 300 }, (_value, index) => `chunk_${index};`);
    try {
      for (const chunk of chunks)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: deltaPayload('msg_1', 'part_1', chunk),
            })
          )
        ).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(failure).not.toHaveBeenCalled();
      expect(published).toHaveLength(1);
      expect(deltaText(published[0]?.payload)).toBe(chunks.join(''));
    } finally {
      outbox.close();
    }
  });

  it('declines an over-frame merge and appends both deltas in order', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    const left = 'a'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.55));
    const right = 'b'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.55));
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', left),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', right),
      });
      expect(first.bytes).toBeLessThanOrEqual(MAX_SANDBOX_CONTROL_FRAME_BYTES);
      expect(second.bytes).toBeLessThanOrEqual(MAX_SANDBOX_CONTROL_FRAME_BYTES);
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(2);
      expect(`${deltaText(published[0]?.payload)}${deltaText(published[1]?.payload)}`).toBe(
        left + right
      );
    } finally {
      outbox.close();
    }
  });

  it('inherits the newer delta deadline so a merged group is not expired early', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const timers = spyOn(globalThis, 'setTimeout');
    const failures: ControlEventOutboxFailure[] = [];
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'first '),
      });
      expect(first.deadlineAt).toBe(61_000);
      expect(outbox.enqueue(first)).toBe(true);
      expect(timers.mock.calls.at(-1)?.[1]).toBe(60_000);

      clock.mockReturnValue(30_000);
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'second'),
      });
      expect(second.deadlineAt).toBe(90_000);
      expect(outbox.enqueue(second)).toBe(true);
      expect(timers.mock.calls.at(-1)?.[1]).toBe(60_000);

      clock.mockReturnValue(first.deadlineAt);
      clearTimeout(timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined);
      const wake = timers.mock.calls.at(-1)?.[0];
      if (typeof wake !== 'function') throw new Error('Missing merged publication deadline');
      wake();
      expect(failures).toHaveLength(0);

      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(0);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.deadlineAt).toBe(second.deadlineAt);
      expect(deltaText(delivered[0]?.publication.payload)).toBe('first second');
    } finally {
      outbox.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('does not merge into a delta publication that is in flight', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
        if (delivered.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'b'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      const draining = outbox.resume();
      await started.promise;
      expect(outbox.enqueue(second)).toBe(true);
      release.resolve();

      expect(await draining).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(deltaText(delivered[0]?.payload)).toBe('a');
      expect(deltaText(delivered[1]?.payload)).toBe('b');
      expect(delivered[0]?.receiptId).toBe(first.receiptId);
      expect(delivered[1]?.receiptId).toBe(second.receiptId);
    } finally {
      release.resolve();
      outbox.close();
    }
  });

  it('does not merge into a delta entry held in a pending batch', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new Error('single publication must not be used in batch mode');
      },
      publishBatch: async publications => {
        batches.push(publications);
        if (batches.length === 1) {
          started.resolve();
          await release.promise;
        }
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      const head = outbox.prepare({
        event: 'session.event',
        session,
        payload: partUpdatedPayload('msg_1', 'part_1', 'snapshot'),
      });
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'b'),
      });
      expect(outbox.enqueue(head)).toBe(true);
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      const draining = outbox.resume();
      await started.promise;
      const held = batches.map(batch => batch.map(publication => publication.payload));
      expect(held[0]).toHaveLength(2);

      const third = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'c'),
      });
      expect(outbox.enqueue(third)).toBe(true);
      expect(batches.map(batch => batch.map(publication => publication.payload))).toEqual(held);
      release.resolve();

      expect(await draining).toBe(true);
      expect(batches).toHaveLength(2);
      expect(deltaText(batches[0]?.[1]?.payload)).toBe('ab');
      expect(batches[1]?.map(item => item.receiptId)).toEqual([third.receiptId]);
      expect(deltaText(batches[1]?.[0]?.payload)).toBe('c');
    } finally {
      release.resolve();
      outbox.close();
    }
  });

  it('releases a merged delta entry within the byte budget after removal', async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const failure = mock();
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
        if ((publication.payload as { type?: string } | undefined)?.type === 'message.updated') {
          started.resolve();
          await release.promise;
        }
      },
      onFailure: failure,
    });
    const filler = 'f'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.85));
    const largeDelta = 'd'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.9));
    try {
      const fillers = [0, 1, 2].map(index =>
        outbox.prepare({
          event: 'session.event',
          session,
          payload: messageUpdatedPayload(`filler_${index}`, filler),
        })
      );
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', largeDelta),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      for (const fillerPublication of fillers) expect(outbox.enqueue(fillerPublication)).toBe(true);

      const draining = outbox.resume();
      await started.promise;

      const fresh = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('fresh', filler),
      });
      expect(outbox.enqueue(fresh)).toBe(true);
      expect(failure).not.toHaveBeenCalled();
      release.resolve();

      expect(await draining).toBe(true);
      expect(published.map(item => item.receiptId)).toEqual([
        first.receiptId,
        ...fillers.map(item => item.receiptId),
        fresh.receiptId,
      ]);
    } finally {
      release.resolve();
      outbox.close();
    }
  });

  it('merges a delta with a tail retained across a disconnected hold', async () => {
    const delivered: ControlEventPublication[] = [];
    let attempts = 0;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
        if (attempts++ === 0) throw new ControlDeliveryError('disconnected', true, 'disconnected');
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'a'),
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(await outbox.resume()).toBe(false);
      await flushMicrotasks();

      const second = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', 'b'),
      });
      expect(outbox.enqueue(second)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(deltaText(delivered[0]?.payload)).toBe('a');
      expect(deltaText(delivered[1]?.payload)).toBe('ab');
      expect(delivered[1]?.receiptId).toBe(first.receiptId);
    } finally {
      outbox.close();
    }
  });

  it('declines an over-frame merge at the entry cap and reports queue_overflow', async () => {
    const published: ControlEventPublication[] = [];
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: failure,
    });
    const left = 'a'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.55));
    const right = 'b'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.55));
    try {
      for (let index = 0; index < MAX_CONTROL_EVENT_OUTBOX_EVENTS - 1; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: { type: 'session.idle', properties: { index } },
            })
          )
        ).toBe(true);
      const tail = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', left),
      });
      expect(outbox.enqueue(tail)).toBe(true);

      const incoming = outbox.prepare({
        event: 'session.event',
        session,
        payload: deltaPayload('msg_1', 'part_1', right),
      });
      expect(outbox.enqueue(incoming)).toBe(false);
      expect(failure).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'queue_overflow',
          publication: expect.objectContaining({ receiptId: incoming.receiptId }),
        })
      );

      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(MAX_CONTROL_EVENT_OUTBOX_EVENTS);
      expect(deltaText(published.at(-1)?.payload)).toBe(left);
    } finally {
      outbox.close();
    }
  });
});

describe('control event outbox batching', () => {
  function progressPublication(index: number, nativeRuntimeId?: string) {
    return {
      event: 'session.event' as const,
      session: {
        ...session,
        ...(nativeRuntimeId === undefined ? {} : { nativeRuntimeId }),
      },
      payload: { type: 'session.updated', properties: { marker: `progress_${index}` } },
    };
  }

  it('collects queued events into one ordered batch within the fixed window', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new Error('single publication must not be used in batch mode');
      },
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 3; index += 1)
        expect(outbox.enqueue(outbox.prepare(progressPublication(index)))).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(batches).toHaveLength(1);
      expect(batches[0]?.map(publication => publication.sequence)).toEqual([1, 2, 3]);
    } finally {
      outbox.close();
    }
  });

  it('flushes an urgent boundary after older queued events without overtaking them', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0)))).toBe(true);
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session,
            payload: { type: 'question.asked', properties: { id: 'question_1' } },
          })
        )
      ).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(batches).toHaveLength(1);
      expect(
        batches[0]?.map(publication => (publication.payload as { type: string }).type)
      ).toEqual(['session.updated', 'question.asked']);
    } finally {
      outbox.close();
    }
  });

  it('splits batches at a native runtime identity boundary', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    const replacement = '11111111-1111-4111-8111-111111111111';
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0, replacement)))).toBe(true);
      expect(outbox.enqueue(outbox.prepare(progressPublication(1)))).toBe(true);
      expect(outbox.enqueue(outbox.prepare(progressPublication(2)))).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(batches.map(batch => batch.length)).toEqual([1, 2]);
      expect(batches[0]?.[0]?.session.nativeRuntimeId).toBe(replacement);
      expect(batches[1]?.every(item => item.session.nativeRuntimeId === undefined)).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('bounds a batch at the item cap and continues with later collection', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 70; index += 1)
        expect(outbox.enqueue(outbox.prepare(progressPublication(index)))).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(batches.map(batch => batch.length)).toEqual([64, 6]);
      expect(batches[0]?.[0]?.sequence).toBe(1);
      expect(batches[0]?.at(-1)?.sequence).toBe(64);
      expect(batches[1]?.[0]?.sequence).toBe(65);
    } finally {
      outbox.close();
    }
  });

  it('keeps the unchanged single-publication protocol when batching is unsupported', async () => {
    const singles: ControlEventPublication[] = [];
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        singles.push(publication);
      },
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => false,
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 3; index += 1)
        expect(outbox.enqueue(outbox.prepare(progressPublication(index)))).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(singles.map(publication => publication.sequence)).toEqual([1, 2, 3]);
      expect(batches).toEqual([]);
    } finally {
      outbox.close();
    }
  });
});

describe('control event outbox batch scheduling', () => {
  function progressPublication(index: number) {
    return {
      event: 'session.event' as const,
      session,
      payload: { type: 'session.updated', properties: { marker: `progress_${index}` } },
    };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('holds an ordinary batch for the fixed collection window and then hands it off', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0)))).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(batches).toHaveLength(0);
      jest.advanceTimersByTime(CONTROL_EVENT_BATCH_WINDOW_MS - 1);
      await flushMicrotasks();
      expect(batches).toHaveLength(0);
      jest.advanceTimersByTime(1);
      expect(await draining).toBe(true);
      expect(batches.map(batch => batch.length)).toEqual([1]);
    } finally {
      outbox.close();
    }
  });

  it('flushes the head on its own window under continuous streaming', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0)))).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      for (let index = 1; index <= 4; index += 1) {
        jest.advanceTimersByTime(5);
        await flushMicrotasks();
        expect(outbox.enqueue(outbox.prepare(progressPublication(index)))).toBe(true);
      }
      expect(batches).toHaveLength(0);
      jest.advanceTimersByTime(5);
      expect(await draining).toBe(true);
      expect(batches.map(batch => batch.length)).toEqual([5]);
    } finally {
      outbox.close();
    }
  });

  it('flushes an urgent boundary without waiting for the collection window', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0)))).toBe(true);
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session,
            payload: { type: 'question.asked', properties: { id: 'question_1' } },
          })
        )
      ).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(batches.map(batch => batch.length)).toEqual([2]);
      expect(await draining).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('flushes when the next batch prefix reaches the frame byte limit', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    const large = 'x'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.55));
    try {
      for (const id of ['msg_a', 'msg_b'])
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: { type: 'message.updated', properties: { info: { id, marker: large } } },
            })
          )
        ).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(batches.map(batch => batch.length)).toEqual([1]);
      jest.advanceTimersByTime(CONTROL_EVENT_BATCH_WINDOW_MS);
      expect(await draining).toBe(true);
      expect(batches.map(batch => batch.length)).toEqual([1, 1]);
    } finally {
      outbox.close();
    }
  });

  it('hands off an item that only fits the single-publication frame', async () => {
    const singles: ControlEventPublication[] = [];
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        singles.push(publication);
      },
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    const measure = (marker: string) =>
      outbox.prepare({
        event: 'session.event',
        session,
        payload: { type: 'message.updated', properties: { info: { id: 'single', marker } } },
      }).bytes;
    try {
      const text = 'x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES - measure('') - 1);
      const nearLimit = outbox.prepare({
        event: 'session.event',
        session,
        payload: { type: 'message.updated', properties: { info: { id: 'single', marker: text } } },
      });
      expect(nearLimit.bytes).toBe(MAX_SANDBOX_CONTROL_FRAME_BYTES - 1);
      expect(outbox.enqueue(nearLimit)).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(singles.map(publication => publication.sequence)).toEqual([nearLimit.sequence]);
      expect(batches).toEqual([]);
      expect(await draining).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('protects the selected batch tail from a synchronous enqueue before handoff', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new Error('single publication must not be used in batch mode');
      },
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 64; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({
              event: 'session.event',
              session,
              payload: messageUpdatedPayload(`msg_${index}`, `old_${index}`),
            })
          )
        ).toBe(true);
      const newer = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('msg_63', 'new_63'),
      });
      const draining = outbox.resume();
      expect(outbox.enqueue(newer)).toBe(true);
      await flushMicrotasks();
      jest.advanceTimersByTime(CONTROL_EVENT_BATCH_WINDOW_MS);
      expect(await draining).toBe(true);
      const published = batches.flat();
      expect(published).toHaveLength(65);
      expect(published.map(item => item.sequence)).toEqual(
        Array.from({ length: 65 }, (_value, index) => index + 1)
      );
      expect(new Set(published.map(item => item.receiptId)).size).toBe(65);
      const tail = published[64];
      if (!tail) throw new Error('Missing tail publication');
      expect(tail.receiptId).not.toBe(published[63]?.receiptId);
      expect(
        (tail.payload as { properties: { info: { id: string; marker: string } } }).properties.info
      ).toMatchObject({ id: 'msg_63', marker: 'new_63' });
    } finally {
      outbox.close();
    }
  });

  it('hands off an identity-closed prefix when its successor is urgent', async () => {
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    const childA = { ...session, kiloSessionId: 'child_a' };
    const childB = { ...session, kiloSessionId: 'child_b' };
    try {
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: childA,
            payload: { type: 'session.updated', properties: { marker: 'ordinary' } },
          })
        )
      ).toBe(true);
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: childB,
            payload: { type: 'question.asked', properties: { id: 'question_1' } },
          })
        )
      ).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(batches.map(batch => batch.map(item => item.session.kiloSessionId))).toEqual([
        ['child_a'],
        ['child_b'],
      ]);
      expect(
        batches.map(batch => batch.map(item => (item.payload as { type: string }).type))
      ).toEqual([['session.updated'], ['question.asked']]);
      expect(await draining).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('cancels the losing collection-window timer once a wake hands off early', async () => {
    const batches: ControlEventPublication[][] = [];
    const setTimer = spyOn(globalThis, 'setTimeout');
    const clearTimer = spyOn(globalThis, 'clearTimeout');
    const outbox = createControlEventOutbox({
      publish: async () => {},
      publishBatch: async publications => {
        batches.push(publications);
      },
      supportsBatches: () => true,
      onFailure: mock(),
    });
    try {
      expect(outbox.enqueue(outbox.prepare(progressPublication(0)))).toBe(true);
      const draining = outbox.resume();
      await flushMicrotasks();
      expect(batches).toHaveLength(0);
      const windowIndex = setTimer.mock.calls.findIndex(
        call => call[1] === CONTROL_EVENT_BATCH_WINDOW_MS
      );
      const windowTimer = setTimer.mock.results[windowIndex]?.value;
      expect(windowTimer).toBeDefined();
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session,
            payload: { type: 'question.asked', properties: { id: 'question_1' } },
          })
        )
      ).toBe(true);
      await flushMicrotasks();
      expect(batches.map(batch => batch.length)).toEqual([2]);
      expect(clearTimer.mock.calls.some(call => call[0] === windowTimer)).toBe(true);
      expect(await draining).toBe(true);
    } finally {
      outbox.close();
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });
});

describe('control event outbox disconnected hold', () => {
  function progressPublication(index: number) {
    return {
      event: 'session.event' as const,
      session,
      payload: { type: 'session.updated', properties: { marker: `progress_${index}` } },
    };
  }

  function questionAsked(id: string) {
    return {
      event: 'session.event' as const,
      session,
      payload: { type: 'question.asked', properties: { id } },
    };
  }

  async function flushMicrotasks(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) await Promise.resolve();
  }

  it('retains a disconnected head and republishes the same identity on resume', async () => {
    const failures: ControlEventOutboxFailure[] = [];
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    let attempts = 0;
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (attempts++ === 0) throw new ControlDeliveryError('disconnected', true, 'disconnected');
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(outbox.enqueue(head)).toBe(true);
      expect(await outbox.resume()).toBe(false);
      expect(failures).toHaveLength(0);
      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(0);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]).toMatchObject({
        publication: {
          receiptId: head.receiptId,
          sequence: head.sequence,
          payload: head.payload,
        },
        deadlineAt: head.deadlineAt,
      });
    } finally {
      outbox.close();
    }
  });

  it('drops a socket_overflow head and keeps publishing without a hold', async () => {
    const failures: ControlEventOutboxFailure[] = [];
    const delivered: ControlEventPublication[] = [];
    let attempts = 0;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
        if (attempts++ === 0) throw new ControlDeliveryError('overflow', true, 'socket_overflow');
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(outbox.enqueue(head)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ reason: 'socket_overflow' });

      const later = outbox.prepare(progressPublication(1));
      expect(outbox.enqueue(later)).toBe(true);
      await flushMicrotasks();
      expect(delivered).toHaveLength(2);
      expect(delivered[1]?.receiptId).toBe(later.receiptId);
      expect(failures).toHaveLength(1);
    } finally {
      outbox.close();
    }
  });

  it('does not spin retrying a disconnected head without a resume', async () => {
    const publish = mock(async () => {
      throw new ControlDeliveryError('disconnected', true, 'disconnected');
    });
    const outbox = createControlEventOutbox({ publish, onFailure: mock() });
    try {
      outbox.enqueue(outbox.prepare(progressPublication(0)));
      expect(await outbox.resume()).toBe(false);
      expect(publish).toHaveBeenCalledTimes(1);
      await flushMicrotasks();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(await outbox.resume()).toBe(false);
      expect(publish).toHaveBeenCalledTimes(2);
    } finally {
      outbox.close();
    }
  });

  it('expires a retained disconnected head at its original deadline', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const timers = spyOn(globalThis, 'setTimeout');
    const failures: ControlEventOutboxFailure[] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new ControlDeliveryError('disconnected', true, 'disconnected');
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(head.deadlineAt).toBe(61_000);
      expect(outbox.enqueue(head)).toBe(true);
      expect(await outbox.resume()).toBe(false);
      expect(failures).toHaveLength(0);
      await flushMicrotasks();

      const wakeup = timers.mock.calls.at(-1);
      const handle = timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined;
      expect(wakeup?.[1]).toBe(60_000);
      clock.mockReturnValue(head.deadlineAt);
      clearTimeout(handle);
      const callback = wakeup?.[0];
      if (typeof callback !== 'function') throw new Error('Missing publication deadline');
      callback();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: 'expired',
        publication: { receiptId: head.receiptId },
      });

      await flushMicrotasks();
      expect(failures).toHaveLength(1);
    } finally {
      outbox.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('expires a disconnected rejection at the deadline without holding', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const failures: ControlEventOutboxFailure[] = [];
    const delivered: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push(publication);
        if (delivered.length === 1) {
          clock.mockReturnValue(deadlineAt);
          throw new ControlDeliveryError('disconnected', true, 'disconnected');
        }
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(outbox.enqueue(head)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: 'expired',
        publication: { receiptId: head.receiptId },
      });

      const later = outbox.prepare(progressPublication(1));
      expect(later.deadlineAt).toBeGreaterThan(head.deadlineAt);
      expect(outbox.enqueue(later)).toBe(true);
      await flushMicrotasks();
      expect(delivered).toHaveLength(2);
      expect(delivered[1]?.receiptId).toBe(later.receiptId);
      expect(failures).toHaveLength(1);
    } finally {
      outbox.close();
      clock.mockRestore();
    }
  });

  it('expires a retained head at its deadline so a later urgent event is not blocked', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const timers = spyOn(globalThis, 'setTimeout');
    const failures: ControlEventOutboxFailure[] = [];
    const delivered: ControlEventPublication[] = [];
    let attempts = 0;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        delivered.push(publication);
        if (attempts++ === 0) throw new ControlDeliveryError('disconnected', true, 'disconnected');
      },
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(outbox.enqueue(head)).toBe(true);
      clock.mockReturnValue(1_001);
      expect(await outbox.resume()).toBe(false);
      expect(failures).toHaveLength(0);
      await flushMicrotasks();

      const urgent = outbox.prepare(questionAsked('question_1'));
      expect(urgent.preparedAt).toBe(1_001);
      expect(urgent.deadlineAt).toBeGreaterThan(head.deadlineAt);
      expect(outbox.enqueue(urgent)).toBe(true);

      const wakeup = timers.mock.calls.at(-1);
      const handle = timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined;
      expect(wakeup?.[1]).toBe(head.deadlineAt - 1_001);

      clock.mockReturnValue(head.deadlineAt);
      clearTimeout(handle);
      const callback = wakeup?.[0];
      if (typeof callback !== 'function') throw new Error('Missing publication deadline');
      callback();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: 'expired',
        publication: { receiptId: head.receiptId },
      });

      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]?.receiptId).toBe(urgent.receiptId);
      expect(failures).toHaveLength(1);
    } finally {
      outbox.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('retains a disconnected batch and republishes the same identities on resume', async () => {
    const failures: ControlEventOutboxFailure[] = [];
    const batches: Array<{ publications: ControlEventPublication[]; deadlineAt: number }> = [];
    let attempts = 0;
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new Error('single publication must not be used in batch mode');
      },
      publishBatch: async (publications, deadlineAt) => {
        batches.push({ publications, deadlineAt });
        if (attempts++ === 0) throw new ControlDeliveryError('disconnected', true, 'disconnected');
      },
      supportsBatches: () => true,
      onFailure: failure => failures.push(failure),
    });
    try {
      const first = outbox.prepare(progressPublication(0));
      const second = outbox.prepare(questionAsked('question_1'));
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);

      expect(await outbox.resume()).toBe(false);
      expect(failures).toHaveLength(0);
      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(0);
      expect(batches).toHaveLength(2);
      const expectedReceiptIds = [first.receiptId, second.receiptId];
      const expectedSequences = [first.sequence, second.sequence];
      for (const batch of batches) {
        expect(batch.publications.map(entry => entry.receiptId)).toEqual(expectedReceiptIds);
        expect(batch.publications.map(entry => entry.sequence)).toEqual(expectedSequences);
        expect(batch.deadlineAt).toBe(first.deadlineAt);
      }
    } finally {
      outbox.close();
    }
  });

  it('expires only the batch head at its deadline and keeps later entries queued', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const failures: ControlEventOutboxFailure[] = [];
    const batches: ControlEventPublication[][] = [];
    const outbox = createControlEventOutbox({
      publish: async () => {
        throw new Error('single publication must not be used in batch mode');
      },
      publishBatch: async (publications, deadlineAt) => {
        batches.push(publications);
        if (batches.length === 1) {
          clock.mockReturnValue(deadlineAt);
          throw new ControlDeliveryError('disconnected', true, 'disconnected');
        }
      },
      supportsBatches: () => true,
      onFailure: failure => failures.push(failure),
    });
    try {
      const head = outbox.prepare(progressPublication(0));
      expect(outbox.enqueue(head)).toBe(true);
      clock.mockReturnValue(1_001);
      const later = outbox.prepare(questionAsked('question_1'));
      expect(later.deadlineAt).toBeGreaterThan(head.deadlineAt);
      expect(outbox.enqueue(later)).toBe(true);

      expect(await outbox.resume()).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        reason: 'expired',
        publication: { receiptId: head.receiptId },
      });
      expect(batches).toHaveLength(2);
      expect(batches[0]?.map(entry => entry.receiptId)).toEqual([head.receiptId, later.receiptId]);
      expect(batches[1]?.map(entry => entry.receiptId)).toEqual([later.receiptId]);
    } finally {
      outbox.close();
      clock.mockRestore();
    }
  });
});
