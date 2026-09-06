import { describe, expect, it, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalControlEventJson } from '../../../src/shared/control-event-canonical';
import { ControlDeliveryError } from './sandbox-control-client';
import { createControlEventOutbox, type ControlEventPublication } from './control-event-outbox';
import {
  MAX_SANDBOX_CONTROL_FRAME_BYTES,
  sandboxEventPublicationPayloadSchema,
} from '../../../src/shared/sandbox-control-protocol';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};

describe('control event outbox', () => {
  it('snapshots native lifetime before replacement and binds it into the receipt hash', async () => {
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
    const hash = (value: unknown) =>
      createHash('sha256').update(canonicalControlEventJson(value)).digest('hex');
    const content = {
      event: parsed.event,
      session: parsed.session,
      payload: parsed.payload,
      sequence: parsed.sequence,
    };
    expect(hash(content)).toBe(first.receiptHash);
    expect(hash({ ...content, session: identity })).not.toBe(first.receiptHash);
    expect(hash({ ...content, session })).not.toBe(first.receiptHash);
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
    expect(wire.receiptHash).toBe(
      createHash('sha256')
        .update(
          canonicalControlEventJson({
            event: wire.event,
            session,
            payload: wire.payload,
            sequence: wire.sequence,
          })
        )
        .digest('hex')
    );
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
        if (phase === 'pending')
          held.reject(new ControlDeliveryError('late old publication failure', false));
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
