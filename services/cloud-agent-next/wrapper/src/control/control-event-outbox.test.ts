import { describe, expect, it, mock, spyOn } from 'bun:test';
import { ControlDeliveryError } from './sandbox-control-client';
import {
  createControlEventOutbox,
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

async function waitFor(condition: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error('Timed out waiting for outbox publication');
}

describe('control event outbox', () => {
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
            requestId: '00000000-0000-4000-8000-000000000000',
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
      expect(first.deadlineAt).toBe(31_000);
      expect(second.deadlineAt).toBe(32_000);
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

  it.each(['entity', 'root', 'native'] as const)(
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
          : { ...session, nativeRuntimeId: firstNativeRuntimeId };
      const secondSession =
        fence === 'root'
          ? { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' }
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

  it('keeps a retry-held head unchanged and queues a newer same-message update behind it', async () => {
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const retried = Promise.withResolvers<void>();
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) throw new ControlDeliveryError('not attached', true);
        if (delivered.length === 2) retried.resolve();
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
      expect(await outbox.resume()).toBe(false);
      expect(outbox.enqueue(second)).toBe(true);
      await retried.promise;
      await waitFor(() => delivered.length === 3, 500);
      expect(delivered[0]?.publication).toEqual(delivered[1]?.publication);
      expect(delivered[0]?.deadlineAt).toBe(first.deadlineAt);
      expect(delivered[2]?.publication).toMatchObject({
        receiptId: second.receiptId,
        sequence: second.sequence,
        payload: second.payload,
      });
      expect(await outbox.resume()).toBe(true);
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

  it('admits a tail replacement at the 256-entry count boundary', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 255; index += 1)
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
      expect(published).toHaveLength(256);
      expect(published.at(-1)).toMatchObject({
        receiptId: old.receiptId,
        sequence: old.sequence,
        payload: latest.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it('does not let a retryable root A head delay root B', async () => {
    const published: ControlEventPublication[] = [];
    let attemptsA = 0;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
        const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
        if (root === 'root_a' && attemptsA++ === 0)
          throw new ControlDeliveryError('root A is not attached', true);
      },
      onFailure: mock(),
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

      expect(await outbox.resume()).toBe(false);
      expect(
        published.map(item => item.session.rootKiloSessionId ?? item.session.kiloSessionId)
      ).toEqual(['root_a', 'root_b']);
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

  it('wakes a retry-ready root while another root receipt remains pending', async () => {
    const releaseB = Promise.withResolvers<void>();
    const rootA = { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' };
    const rootB = { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' };
    let attemptsA = 0;
    let startedB = false;
    let retriedA = false;
    const outbox = createControlEventOutbox({
      publish: async publication => {
        const root = publication.session.rootKiloSessionId ?? publication.session.kiloSessionId;
        if (root === 'root_a') {
          attemptsA += 1;
          if (attemptsA === 1) throw new ControlDeliveryError('root A is not attached', true);
          retriedA = true;
          return;
        }
        startedB = true;
        await releaseB.promise;
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
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session: rootB,
          payload: { type: 'session.idle' },
        })
      );
      const draining = outbox.resume();
      await waitFor(() => startedB);
      await waitFor(() => retriedA, 500);
      releaseB.resolve();
      expect(await draining).toBe(true);
    } finally {
      releaseB.resolve();
      outbox.close();
    }
  });

  it('keeps entry, byte, and waiter limits independent per root', async () => {
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
    const rootA = { ...session, kiloSessionId: 'root_a', rootKiloSessionId: 'root_a' };
    const rootB = { ...session, kiloSessionId: 'root_b', rootKiloSessionId: 'root_b' };
    const small = { type: 'session.idle', properties: {} };
    try {
      for (let index = 0; index < 256; index += 1)
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session: rootA, payload: small }))
        ).toBe(true);
      expect(
        outbox.enqueue(outbox.prepare({ event: 'session.event', session: rootA, payload: small }))
      ).toBe(false);
      expect(
        outbox.enqueue(outbox.prepare({ event: 'session.event', session: rootB, payload: small }))
      ).toBe(true);

      outbox.pause();
      outbox.close();
      const bytesOutbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
      try {
        const medium = {
          type: 'message.updated',
          properties: { text: 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45)) },
        };
        for (let index = 0; index < 256; index += 1) {
          if (
            !bytesOutbox.enqueue(
              bytesOutbox.prepare({ event: 'session.event', session: rootA, payload: medium })
            )
          )
            break;
        }
        expect(
          bytesOutbox.enqueue(
            bytesOutbox.prepare({ event: 'session.event', session: rootA, payload: medium })
          )
        ).toBe(false);
        expect(
          bytesOutbox.enqueue(
            bytesOutbox.prepare({ event: 'session.event', session: rootB, payload: medium })
          )
        ).toBe(true);
      } finally {
        bytesOutbox.close();
      }

      const waiterOutbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
      try {
        for (let index = 0; index < 256; index += 1)
          expect(
            waiterOutbox.enqueue(
              waiterOutbox.prepare({ event: 'session.event', session: rootA, payload: small })
            )
          ).toBe(true);
        const rootWaiters: Array<Promise<boolean>> = [];
        for (let index = 0; index < 256; index += 1) {
          const publication = waiterOutbox.prepare({
            event: 'session.event',
            session: rootA,
            payload: small,
          });
          expect(waiterOutbox.enqueue(publication)).toBe(false);
          rootWaiters.push(waiterOutbox.waitForSpace(publication));
        }
        for (let index = 0; index < 256; index += 1)
          expect(
            waiterOutbox.enqueue(
              waiterOutbox.prepare({ event: 'session.event', session: rootB, payload: small })
            )
          ).toBe(true);
        const rootBPublication = waiterOutbox.prepare({
          event: 'session.event',
          session: rootB,
          payload: small,
        });
        expect(waiterOutbox.enqueue(rootBPublication)).toBe(false);
        const rootBWaiter = waiterOutbox.waitForSpace(rootBPublication);
        let settled = false;
        void rootBWaiter.then(() => {
          settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);
        waiterOutbox.close();
        expect(await rootBWaiter).toBe(false);
        expect(await Promise.all(rootWaiters)).toEqual(Array.from({ length: 256 }, () => false));
      } finally {
        waiterOutbox.close();
      }
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

  it('autonomously retries one stable receipt without future events or resume calls', async () => {
    const published: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const retried = Promise.withResolvers<void>();
    const failure = mock();
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        published.push({ publication, deadlineAt });
        if (published.length === 1) throw new ControlDeliveryError('offline', true);
        retried.resolve();
      },
      onFailure: failure,
    });
    try {
      const publication = outbox.prepare({
        event: 'session.event',
        session,
        payload: { type: 'message.updated', properties: { id: 'msg_1' } },
      });
      expect(outbox.enqueue(publication)).toBe(true);
      expect(await outbox.resume()).toBe(false);
      await retried.promise;
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveLength(2);
      expect(published[1]).toEqual(published[0]);
      expect(published[1]?.deadlineAt).toBe(publication.deadlineAt);
      expect(failure).not.toHaveBeenCalled();
    } finally {
      outbox.close();
    }
  });

  it('coalesces retry triggers and never overlaps publication attempts', async () => {
    const retried = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const published: number[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication.sequence);
        if (published.length === 1) throw new ControlDeliveryError('not attached', true);
        if (published.length === 2) {
          retried.resolve();
          await release.promise;
        }
      },
      onFailure: mock(),
    });
    const publication = () =>
      outbox.prepare({ event: 'session.event', session, payload: { type: 'session.idle' } });
    try {
      outbox.enqueue(publication());
      expect(await outbox.resume()).toBe(false);
      for (let index = 0; index < 20; index += 1) {
        outbox.enqueue(publication());
        expect(await outbox.resume()).toBe(false);
      }
      expect(published).toEqual([1]);
      await retried.promise;
      const draining = outbox.resume();
      for (let index = 0; index < 20; index += 1) expect(outbox.resume()).toBe(draining);
      expect(published).toEqual([1, 1]);
      release.resolve();
      expect(await draining).toBe(true);
      expect(published).toEqual([1, ...Array.from({ length: 21 }, (_, index) => index + 1)]);
    } finally {
      release.resolve();
      outbox.close();
    }
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

  it('settles an in-flight pump on close without reporting expiry or publishing queued events', async () => {
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
    expect(failure).not.toHaveBeenCalled();
    expect(await outbox.resume()).toBe(false);
  });

  it.each(['retry', 'paused', 'pending'] as const)(
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
        expect(original.deadlineAt).toBe(31_000);
        outbox.enqueue(original);
        clock.mockReturnValue(30_900);
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session: { ...session, nativeRuntimeId: replacementId },
            payload: { type: 'session.idle' },
          })
        );
        const pumping = phase === 'paused' ? undefined : outbox.resume();
        if (phase === 'retry') expect(await pumping).toBe(false);
        else await Promise.resolve();
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
        expect(failure).toHaveBeenCalledWith({ reason: 'expired', publication: original });
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

  it.each(['pause', 'close', 'permanent'] as const)(
    'does not retry after %s and reports permanent failure only once',
    async stop => {
      const published = mock(async () => {
        throw new ControlDeliveryError('unavailable', stop !== 'permanent');
      });
      const failure = mock();
      const outbox = createControlEventOutbox({ publish: published, onFailure: failure });
      try {
        outbox.enqueue(
          outbox.prepare({ event: 'session.event', session, payload: { type: 'session.idle' } })
        );
        expect(await outbox.resume()).toBe(stop === 'permanent');
        if (stop === 'pause') outbox.pause();
        else if (stop === 'close') outbox.close();
        else {
          expect(await outbox.resume()).toBe(true);
          expect(await outbox.resume()).toBe(true);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(published).toHaveBeenCalledTimes(1);
        expect(failure).toHaveBeenCalledTimes(stop === 'permanent' ? 1 : 0);
      } finally {
        outbox.close();
      }
    }
  );

  it('settles an expired backpressured publication without failing the replacement outbox', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const timers = spyOn(globalThis, 'setTimeout');
    const failure = mock();
    const published = mock(async () => {});
    const outbox = createControlEventOutbox({ publish: published, onFailure: failure });
    const prepare = () =>
      outbox.prepare({ event: 'session.event', session, payload: { type: 'session.idle' } });
    try {
      const expired = prepare();
      clock.mockReturnValue(2_000);
      for (let index = 0; index < 256; index += 1) expect(outbox.enqueue(prepare())).toBe(true);
      expect(outbox.enqueue(expired)).toBe(false);
      const waiting = outbox.waitForSpace(expired);
      const expire = timers.mock.calls.at(-1)?.[0];
      if (typeof expire !== 'function') throw new Error('Missing backpressure deadline');
      clock.mockReturnValue(expired.deadlineAt);
      clearTimeout(timers.mock.results.at(-1)?.value as ReturnType<typeof setTimeout> | undefined);
      expire();
      expect(await waiting).toBe(true);
      expect(outbox.enqueue(expired)).toBe(true);
      expect(failure).toHaveBeenCalledWith({ reason: 'expired', publication: expired });
      expect(await outbox.resume()).toBe(true);
      expect(published).toHaveBeenCalledTimes(256);
    } finally {
      outbox.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });

  it('applies producer backpressure only after the bounded offline burst', () => {
    const published = mock(async () => {});
    const failed = mock();
    const outbox = createControlEventOutbox({ publish: published, onFailure: failed });

    for (let index = 0; index < 256; index += 1)
      expect(
        outbox.enqueue(
          outbox.prepare({
            event: 'session.event',
            session,
            payload: { type: 'message.updated', properties: { id: `msg_${index}` } },
          })
        )
      ).toBe(true);
    expect(
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session,
          payload: { type: 'message.updated', properties: { id: 'overflow' } },
        })
      )
    ).toBe(false);
    expect(failed).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    outbox.close();
  });

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

  it('waits for the exact byte footprint of one prepared publication', async () => {
    const firstPublication = Promise.withResolvers<void>();
    let calls = 0;
    const outbox = createControlEventOutbox({
      publish: async () => {
        calls += 1;
        if (calls === 1) await firstPublication.promise;
      },
      onFailure: mock(),
    });
    const medium = () =>
      outbox.prepare({
        event: 'session.event',
        session,
        payload: {
          type: 'message.updated',
          properties: { text: 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45)) },
        },
      });
    for (let index = 0; index < 8; index += 1) expect(outbox.enqueue(medium())).toBe(true);
    const blocked = outbox.prepare({
      event: 'session.event',
      session,
      payload: {
        type: 'message.updated',
        properties: { text: 'l'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.7)) },
      },
    });
    expect(outbox.enqueue(blocked)).toBe(false);
    const waiting = outbox.waitForSpace(blocked);
    let settled = false;
    void waiting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    const pumping = outbox.resume();
    firstPublication.resolve();
    expect(await waiting).toBe(true);
    expect(outbox.enqueue(blocked)).toBe(true);
    await pumping;
  });

  it('wakes a blocked producer when the outbox closes', async () => {
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
    for (let index = 0; index < 256; index += 1)
      outbox.enqueue(
        outbox.prepare({
          event: 'session.event',
          session,
          payload: { type: 'message.updated', properties: { id: `msg_${index}` } },
        })
      );
    const blocked = outbox.prepare({
      event: 'session.event',
      session,
      payload: { type: 'message.updated', properties: { id: 'blocked' } },
    });
    const waiting = outbox.waitForSpace(blocked);
    outbox.close();
    expect(await waiting).toBe(false);
  });
});
