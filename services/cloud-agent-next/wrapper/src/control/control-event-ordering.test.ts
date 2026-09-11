import { describe, expect, it, mock, spyOn } from 'bun:test';
import { MAX_SANDBOX_CONTROL_FRAME_BYTES } from '../../../src/shared/sandbox-control-protocol';
import {
  controlEventReceiptDisposition,
  recordControlEventReceipt,
  readControlEventReceipts,
} from '../../../src/sandbox-session/control-event-receipts';
import { createControlEventTransport } from './control-event-transport';
import { createControlEventOutbox, type ControlEventPublication } from './control-event-outbox';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};
const medium = {
  type: 'message.updated',
  properties: { text: 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45)) },
};
const large = {
  type: 'message.updated',
  properties: { text: 'l'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.7)) },
};
const small = { type: 'session.idle', properties: {} };

function messageUpdatedPayload(id: string, text: string, sessionID = session.kiloSessionId) {
  return {
    type: 'message.updated',
    properties: { info: { id, sessionID, role: 'assistant', text } },
  };
}

function receiptStorage() {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      values.set(key, value);
    },
  };
}

describe('control event publication ordering', () => {
  it.each(['session.event', 'session.preparing'] as const)(
    'backpressures a later synchronous %s behind a larger native event for the same Session',
    async event => {
      const storage = receiptStorage();
      const wrapperInstanceId = crypto.randomUUID();
      const applied: ControlEventPublication[] = [];
      const rejected: ControlEventPublication[] = [];
      const failure = mock();
      const transport = createControlEventTransport({
        supportsReceipts: () => true,
        prepare: input => input,
        publish: async publication => {
          const receipt = { ...publication, wrapperInstanceId };
          if (controlEventReceiptDisposition(storage, receipt) !== 'apply') {
            rejected.push(publication);
            return;
          }
          recordControlEventReceipt(storage, receipt);
          applied.push(publication);
        },
        sendLegacy: () => false,
        onFailure: failure,
      });
      try {
        for (let index = 0; index < 8; index += 1)
          expect(transport.enqueue('session.event', medium, session)).toBe(true);
        const native = transport.publishSessionEvent(large, session);
        const overtook = transport.enqueue(event, small, session);
        await transport.resume();
        expect(await native).toBe(true);
        if (!overtook) expect(transport.enqueue(event, small, session)).toBe(true);
        expect(await transport.resume()).toBe(true);
        expect(rejected.map(publication => publication.sequence)).toEqual([]);
        expect(overtook).toBe(false);
        expect(applied.map(publication => publication.sequence)).toEqual([
          1, 2, 3, 4, 5, 6, 7, 8, 9, 11,
        ]);
        expect(applied[8]?.payload).toEqual(large);
        expect(applied[9]?.payload).toEqual(small);
        expect(failure).not.toHaveBeenCalled();
      } finally {
        transport.close();
      }
    }
  );

  it('keeps the older reservation through wakeup and preserves its original receipt', async () => {
    const published: ControlEventPublication[] = [];
    const outbox = createControlEventOutbox({
      publish: async publication => {
        published.push(publication);
      },
      onFailure: mock(),
    });
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: medium }))
        ).toBe(true);
      const older = outbox.prepare({ event: 'session.event', session, payload: large });
      const original = structuredClone(older);
      expect(outbox.enqueue(older)).toBe(false);
      const waiting = outbox.waitForSpace(older);
      const later = outbox.prepare({
        event: 'session.preparing',
        session: { ...session, kiloSessionId: 'ses_child' },
        payload: small,
      });
      expect(outbox.enqueue(later)).toBe(false);
      const draining = outbox.resume();
      expect(await waiting).toBe(true);
      expect(outbox.enqueue(later)).toBe(false);
      expect(outbox.enqueue(older)).toBe(true);
      expect(outbox.enqueue(later)).toBe(true);
      await draining;
      expect(await outbox.resume()).toBe(true);
      expect(published.map(publication => publication.sequence)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ]);
      expect(older).toEqual(original);
      expect(published[8]).toMatchObject({
        receiptId: original.receiptId,
        sequence: original.sequence,
        session: original.session,
        payload: original.payload,
      });
    } finally {
      outbox.close();
    }
  });

  it('compares a waiting publication with the current tail when it is admitted', async () => {
    const startedFirst = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const startedSecond = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 1) {
          startedFirst.resolve();
          await releaseFirst.promise;
        } else if (delivered.length === 2) {
          startedSecond.resolve();
          await releaseSecond.promise;
        }
      },
      onFailure: mock(),
    });
    const filler = 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45));
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
      const waiting = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload(
          'target',
          'l'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.7))
        ),
      });
      expect(outbox.enqueue(old)).toBe(true);
      expect(outbox.enqueue(waiting)).toBe(false);
      const admitted = outbox.waitForSpace(waiting);
      const draining = outbox.resume();
      await startedFirst.promise;
      releaseFirst.resolve();
      await startedSecond.promise;
      expect(await admitted).toBe(true);
      expect(outbox.enqueue(waiting)).toBe(true);
      releaseSecond.resolve();
      expect(await draining).toBe(true);

      const targetPublications = delivered.filter(
        item => item.publication.sequence === old.sequence
      );
      expect(targetPublications).toHaveLength(1);
      expect(targetPublications[0]).toMatchObject({
        publication: {
          receiptId: old.receiptId,
          sequence: old.sequence,
          payload: waiting.payload,
        },
        deadlineAt: old.deadlineAt,
      });
    } finally {
      releaseFirst.resolve();
      releaseSecond.resolve();
      outbox.close();
    }
  });

  it('preserves receipt high-water across a squash and same-root child successor', async () => {
    const storage = receiptStorage();
    const wrapperInstanceId = crypto.randomUUID();
    const applied: ControlEventPublication[] = [];
    const root = session;
    const child = { ...session, kiloSessionId: 'ses_child' };
    const outbox = createControlEventOutbox({
      publish: async publication => {
        const receipt = { ...publication, wrapperInstanceId };
        expect(controlEventReceiptDisposition(storage, receipt)).toBe('apply');
        recordControlEventReceipt(storage, receipt);
        applied.push(publication);
      },
      onFailure: mock(),
    });
    try {
      const first = outbox.prepare({
        event: 'session.event',
        session: root,
        payload: messageUpdatedPayload('msg_1', 'first'),
      });
      const second = outbox.prepare({
        event: 'session.event',
        session: root,
        payload: messageUpdatedPayload('msg_1', 'latest'),
      });
      const successor = outbox.prepare({
        event: 'session.event',
        session: child,
        payload: { type: 'session.idle', properties: {} },
      });
      expect(outbox.enqueue(first)).toBe(true);
      expect(outbox.enqueue(second)).toBe(true);
      expect(outbox.enqueue(successor)).toBe(true);
      expect(second.sequence).toBe(first.sequence + 1);
      expect(successor.sequence).toBe(second.sequence + 1);

      expect(await outbox.resume()).toBe(true);
      expect(applied.map(publication => publication.sequence)).toEqual([
        first.sequence,
        successor.sequence,
      ]);
      expect(applied[0]).toMatchObject({
        receiptId: first.receiptId,
        sequence: first.sequence,
        payload: second.payload,
      });
      expect(applied[1]).toMatchObject({
        receiptId: successor.receiptId,
        sequence: successor.sequence,
        session: child,
        payload: successor.payload,
      });
      expect(
        controlEventReceiptDisposition(storage, {
          receiptId: second.receiptId,
          sequence: second.sequence,
          wrapperInstanceId,
        })
      ).toBe('stale');
      expect(
        controlEventReceiptDisposition(storage, {
          receiptId: successor.receiptId,
          sequence: successor.sequence,
          wrapperInstanceId,
        })
      ).toBe('duplicate');
      expect(readControlEventReceipts(storage).highWater[wrapperInstanceId]).toBe(
        successor.sequence
      );
    } finally {
      outbox.close();
    }
  });

  it('re-evaluates a waiting publication after its matching tail is sent and removed', async () => {
    const startedTarget = Promise.withResolvers<void>();
    const releaseTarget = Promise.withResolvers<void>();
    const delivered: Array<{ publication: ControlEventPublication; deadlineAt: number }> = [];
    const outbox = createControlEventOutbox({
      publish: async (publication, deadlineAt) => {
        delivered.push({ publication, deadlineAt });
        if (delivered.length === 9) {
          startedTarget.resolve();
          await releaseTarget.promise;
        }
      },
      onFailure: mock(),
    });
    const filler = 'm'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.45));
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
      const prior = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload('target', 'prior'),
      });
      expect(outbox.enqueue(prior)).toBe(true);
      const older = outbox.prepare({
        event: 'session.event',
        session,
        payload: { type: 'session.idle', properties: {} },
      });
      const olderWaiting = outbox.waitForSpace(older);
      const waiting = outbox.prepare({
        event: 'session.event',
        session,
        payload: messageUpdatedPayload(
          'target',
          'l'.repeat(Math.floor(MAX_SANDBOX_CONTROL_FRAME_BYTES * 0.7))
        ),
      });
      expect(waiting.bytes).toBeGreaterThan(prior.bytes);
      expect(outbox.enqueue(waiting)).toBe(false);
      const waitingReady = outbox.waitForSpace(waiting);
      let waitingSettled = false;
      void waitingReady.then(() => {
        waitingSettled = true;
      });
      await Promise.resolve();
      expect(waitingSettled).toBe(false);
      const draining = outbox.resume();
      await startedTarget.promise;
      expect(waitingSettled).toBe(false);
      releaseTarget.resolve();
      expect(await draining).toBe(true);
      expect(waitingSettled).toBe(false);
      expect(await olderWaiting).toBe(true);
      expect(outbox.enqueue(older)).toBe(true);
      expect(await waitingReady).toBe(true);
      expect(outbox.enqueue(waiting)).toBe(true);
      expect(await outbox.resume()).toBe(true);
      expect(delivered).toHaveLength(11);
      expect(delivered[8]).toMatchObject({
        publication: {
          receiptId: prior.receiptId,
          sequence: prior.sequence,
          payload: prior.payload,
        },
        deadlineAt: prior.deadlineAt,
      });
      expect(delivered.at(-1)).toMatchObject({
        publication: {
          receiptId: waiting.receiptId,
          sequence: waiting.sequence,
          payload: waiting.payload,
        },
        deadlineAt: waiting.deadlineAt,
      });
    } finally {
      releaseTarget.resolve();
      outbox.close();
    }
  });

  it.each(['count', 'bytes'] as const)(
    'bounds waiting reservations by %s and coalesces repeated waits',
    async budget => {
      const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
      try {
        for (let index = 0; index < (budget === 'count' ? 256 : 8); index += 1)
          expect(
            outbox.enqueue(
              outbox.prepare({
                event: 'session.event',
                session,
                payload: budget === 'count' ? small : medium,
              })
            )
          ).toBe(true);
        const prepare = () =>
          outbox.prepare({
            event: 'session.event',
            session,
            payload: budget === 'count' ? small : large,
          });
        const first = prepare();
        const limit =
          budget === 'count'
            ? 256
            : Math.floor((4 * MAX_SANDBOX_CONTROL_FRAME_BYTES) / first.bytes);
        const waiting = [outbox.waitForSpace(first)];
        for (let index = 1; index < limit; index += 1) waiting.push(outbox.waitForSpace(prepare()));
        expect(outbox.waitForSpace(first)).toBe(waiting[0]);
        expect(await outbox.waitForSpace(prepare())).toBe(false);
        outbox.close();
        expect(await Promise.all(waiting)).toEqual(Array.from({ length: limit }, () => false));
      } finally {
        outbox.close();
      }
    }
  );

  it('keeps a woken reservation isolated from another root lane', async () => {
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: mock() });
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: medium }))
        ).toBe(true);
      const older = outbox.prepare({ event: 'session.event', session, payload: large });
      expect(outbox.enqueue(older)).toBe(false);
      const waiting = outbox.waitForSpace(older);
      expect(await outbox.resume()).toBe(true);
      expect(await waiting).toBe(true);
      outbox.pause();
      const other = { ...session, kiloSessionId: 'ses_other', rootKiloSessionId: 'ses_other' };
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(
            outbox.prepare({ event: 'session.event', session: other, payload: medium })
          )
        ).toBe(true);
      expect(outbox.enqueue(older)).toBe(true);
    } finally {
      outbox.close();
    }
  });

  it('releases an expired ordering reservation and wakes its same-root successor', async () => {
    const clock = spyOn(Date, 'now').mockReturnValue(1_000);
    const timers = spyOn(globalThis, 'setTimeout');
    const failure = mock();
    const outbox = createControlEventOutbox({ publish: async () => {}, onFailure: failure });
    try {
      for (let index = 0; index < 8; index += 1)
        expect(
          outbox.enqueue(outbox.prepare({ event: 'session.event', session, payload: medium }))
        ).toBe(true);
      const older = outbox.prepare({ event: 'session.event', session, payload: large });
      expect(outbox.enqueue(older)).toBe(false);
      const waiting = outbox.waitForSpace(older);
      const expire = timers.mock.calls.at(-1)?.[0];
      if (typeof expire !== 'function') throw new Error('Missing reservation deadline');
      clock.mockReturnValue(2_000);
      const later = outbox.prepare({ event: 'session.preparing', session, payload: small });
      expect(outbox.enqueue(later)).toBe(false);
      const laterWaiting = outbox.waitForSpace(later);
      clock.mockReturnValue(older.deadlineAt);
      expire();
      expect(await waiting).toBe(true);
      expect(await laterWaiting).toBe(true);
      expect(outbox.enqueue(older)).toBe(true);
      expect(failure).toHaveBeenCalledWith({ reason: 'expired', publication: older });
      expect(outbox.enqueue(later)).toBe(true);
    } finally {
      outbox.close();
      timers.mockRestore();
      clock.mockRestore();
    }
  });
});
