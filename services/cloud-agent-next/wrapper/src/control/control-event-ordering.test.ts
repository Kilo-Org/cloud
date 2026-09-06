import { describe, expect, it, mock, spyOn } from 'bun:test';
import { MAX_SANDBOX_CONTROL_FRAME_BYTES } from '../../../src/shared/sandbox-control-protocol';
import {
  controlEventReceiptDisposition,
  recordControlEventReceipt,
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
        receiptHash: original.receiptHash,
        sequence: original.sequence,
        session: original.session,
        payload: original.payload,
      });
    } finally {
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

  it('re-arms a woken reservation if another Session consumes the available bytes', async () => {
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
      expect(outbox.enqueue(older)).toBe(false);
      const waitingAgain = outbox.waitForSpace(older);
      expect(waitingAgain).not.toBe(waiting);
      expect(outbox.waitForSpace(older)).toBe(waitingAgain);
      let settled = false;
      void waitingAgain.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      outbox.close();
      expect(await waitingAgain).toBe(false);
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
