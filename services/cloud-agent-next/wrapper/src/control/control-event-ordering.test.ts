import { describe, expect, it, mock } from 'bun:test';
import {
  controlEventReceiptDisposition,
  recordControlEventReceipt,
  readControlEventReceipts,
} from '../../../src/sandbox-session/control-event-receipts';
import { createControlEventOutbox, type ControlEventPublication } from './control-event-outbox';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};

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
});
