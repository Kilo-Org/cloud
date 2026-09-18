import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  createControlEventFailureHandler,
  createControlEventTransport,
} from './control-event-transport';
import type { ControlEventOutboxFailure, ControlEventPublication } from './control-event-outbox';
import { ControlDeliveryError } from './sandbox-control-client';
import { createOperationRegistry } from './operation-registry';
import { acknowledgeOperation, fakeKilo, operationAuthorization } from './control-test-fixtures';
import {
  rememberAttachedRoot,
  rememberChildSession,
  resetSessionDirectoryState,
} from './session-directories';
import type {
  SessionOperationAck,
  SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol';
import type { NativeRetirement, RetireDirectoryResult } from './session-operation-cleanup';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};
const payload = { type: 'session.idle', properties: {} };

describe('native-scoped control event failures', () => {
  beforeEach(() => {
    resetSessionDirectoryState();
    rememberAttachedRoot(session.kiloSessionId, session.directory);
  });

  it.each([
    ['session.preparing', true],
    ['session.event', true],
  ] as const)(
    'routes an expired %s publication to its native runtime owner',
    async (event, retires) => {
      const clock = spyOn(Date, 'now').mockReturnValue(1_000);
      const runtime = { runtimeId: crypto.randomUUID() };
      const retired = mock();
      const handleFailure = createControlEventFailureHandler({
        getRuntime: () => runtime,
        onFailure: retired,
      });
      const reported = mock((failure: ControlEventOutboxFailure) => handleFailure(failure));
      const transport = createControlEventTransport({
        supportsReceipts: () => true,
        prepare: input => input,
        publish: async () => {},
        sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
        onFailure: reported,
      });
      try {
        expect(
          transport.enqueue(event, payload, { ...session, nativeRuntimeId: runtime.runtimeId })
        ).toBe(true);
        clock.mockReturnValue(61_000);
        expect(await transport.resume()).toBe(true);
        expect(reported).toHaveBeenCalledTimes(1);
        expect(retired).toHaveBeenCalledTimes(retires ? 1 : 0);
      } finally {
        transport.close();
        clock.mockRestore();
      }
    }
  );

  it.each(['expired', 'rejected'] as const)(
    'reports an immutable N1 %s publication without retiring or blocking N2',
    async reason => {
      const clock = spyOn(Date, 'now').mockReturnValue(1_000);
      const originalNativeId = crypto.randomUUID();
      const identity = { ...session, nativeRuntimeId: originalNativeId };
      const replacement = { runtimeId: crypto.randomUUID() };
      const retired = mock();
      const handleFailure = createControlEventFailureHandler({
        getRuntime: directory => (directory === session.directory ? replacement : undefined),
        onFailure: retired,
      });
      const failures: ControlEventOutboxFailure[] = [];
      const published: ControlEventPublication[] = [];
      const transport = createControlEventTransport({
        supportsReceipts: () => true,
        prepare: input => input,
        publish: async publication => {
          published.push(publication);
          if (publication.sequence === 1) throw new ControlDeliveryError('rejected', false);
        },
        sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
        onFailure: failure => {
          failures.push(failure);
          handleFailure(failure);
        },
      });
      try {
        expect(transport.enqueue('session.event', payload, identity)).toBe(true);
        identity.nativeRuntimeId = replacement.runtimeId;
        clock.mockReturnValue(2_000);
        expect(transport.enqueue('session.event', payload, identity)).toBe(true);
        if (reason === 'expired') clock.mockReturnValue(61_000);
        expect(await transport.resume()).toBe(true);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          reason,
          publication: {
            event: 'session.event',
            receiptId: expect.any(String),
            sequence: 1,
            session: { ...session, nativeRuntimeId: originalNativeId },
          },
        });
        expect(retired).not.toHaveBeenCalled();
        expect(published.at(-1)?.session.nativeRuntimeId).toBe(replacement.runtimeId);
        expect(await transport.publishSessionEvent(payload, identity)).toBe(true);
        expect(await transport.resume()).toBe(true);
        expect(published.map(publication => publication.sequence)).toEqual(
          reason === 'expired' ? [2, 3] : [1, 2, 3]
        );
        expect(failures).toHaveLength(1);
        expect(retired).not.toHaveBeenCalled();
      } finally {
        transport.close();
        clock.mockRestore();
      }
    }
  );

  it('reports each failed native-lifetime publication and ignores stale runtime failures', async () => {
    const original = { runtimeId: crypto.randomUUID() };
    let current = original;
    const retired = mock();
    const cleanup = Promise.withResolvers<void>();
    const handleFailure = createControlEventFailureHandler({
      getRuntime: () => current,
      onFailure: (...args) => {
        retired(...args);
        return cleanup.promise;
      },
    });
    const failures: ControlEventOutboxFailure[] = [];
    const published: ControlEventPublication[] = [];
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      prepare: input => input,
      publish: async publication => {
        published.push(publication);
        if (publication.session.nativeRuntimeId === original.runtimeId)
          throw new ControlDeliveryError('rejected', false);
      },
      sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
      onFailure: failure => {
        failures.push(failure);
        handleFailure(failure);
      },
    });
    try {
      for (let index = 0; index < 2; index += 1)
        expect(
          transport.enqueue('session.event', payload, {
            ...session,
            nativeRuntimeId: original.runtimeId,
          })
        ).toBe(true);
      expect(await transport.resume()).toBe(true);
      expect(failures).toHaveLength(2);
      expect(retired).toHaveBeenCalledTimes(2);
      expect(retired).toHaveBeenCalledWith(failures[0], original);
      expect(retired).toHaveBeenCalledWith(failures[1], original);
      cleanup.resolve();
      await Promise.resolve();
      current = { runtimeId: crypto.randomUUID() };
      expect(
        await transport.publishSessionEvent(payload, {
          ...session,
          nativeRuntimeId: current.runtimeId,
        })
      ).toBe(true);
      expect(await transport.resume()).toBe(true);
      expect(published.at(-1)?.session.nativeRuntimeId).toBe(current.runtimeId);
      handleFailure(failures[0]);
      expect(retired).toHaveBeenCalledTimes(2);
      const failure = failures[0];
      if (!failure) throw new Error('Missing native failure');
      handleFailure({
        ...failure,
        publication: {
          ...failure.publication,
          session: { ...session, nativeRuntimeId: current.runtimeId },
        },
      });
      expect(retired).toHaveBeenCalledTimes(3);
      expect(retired.mock.calls[2]?.[1]).toBe(current);
    } finally {
      transport.close();
    }
  });

  it('reports distinct-root native failures to the runtime owner and ignores stale incarnations', async () => {
    rememberAttachedRoot('root_a', session.directory);
    rememberAttachedRoot('root_b', session.directory);
    const runtime = { runtimeId: 'N1' };
    const cleanup = Promise.withResolvers<void>();
    const failures: ControlEventOutboxFailure[] = [];
    const handleFailure = createControlEventFailureHandler({
      getRuntime: () => runtime,
      onFailure: failure => {
        failures.push(failure);
        return cleanup.promise;
      },
    });
    const failure = (root: string, nativeRuntimeId: string): ControlEventOutboxFailure => ({
      reason: 'rejected',
      publication: {
        event: 'session.event',
        receiptId: `${root}-${nativeRuntimeId}`,
        sequence: failures.length + 1,
        session: { ...session, kiloSessionId: root, rootKiloSessionId: root, nativeRuntimeId },
        payload,
      },
    });

    handleFailure(failure('root_a', 'N1'));
    handleFailure(failure('root_a', 'N1'));
    handleFailure(failure('root_b', 'N1'));
    expect(failures).toHaveLength(3);
    cleanup.resolve();
    await Promise.resolve();
    handleFailure(failure('root_a', 'N1'));
    expect(failures).toHaveLength(4);

    runtime.runtimeId = 'N2';
    handleFailure(failure('root_a', 'N1'));
    handleFailure(failure('root_a', 'N2'));
    expect(failures).toHaveLength(5);
  });

  it('preserves a sealed result and its acknowledgement when failure retires the matching native runtime', async () => {
    const nativeLifetime = new AbortController();
    const runtime = {
      runtimeId: crypto.randomUUID(),
      scopeId: 'scope_1',
      directory: session.directory,
      env: {},
      kiloClient: fakeKilo(),
      signal: nativeLifetime.signal,
    };
    const target = { runtimeId: runtime.runtimeId, client: runtime.kiloClient };
    const nativeRetire = mock(async (): Promise<NativeRetirement> => {
      nativeLifetime.abort();
      return 'retired';
    });
    const registry = createOperationRegistry({
      native: {
        get: () => runtime,
        getRetained: () => runtime,
        retireRuntime: nativeRetire,
        verifyQuiescence: async () => true,
      },
      onStarted: mock(),
      onCompleted: mock(),
      retireRuntime: mock(),
    });
    const sending = Promise.withResolvers<SessionOperationDelivery>();
    const acknowledgement = Promise.withResolvers<SessionOperationAck>();
    const authorization = operationAuthorization('session.attach');
    const operation = registry.start(
      authorization.session,
      authorization,
      {
        operation: 'session.attach',
        payload: {},
        apply: async (_session, _payload, deps) => {
          deps.onRuntime?.(runtime);
          return { ok: true, result: { attached: true } };
        },
        onAttached: mock(),
      },
      {
        emitSessionEvent: mock(),
        sendOperationResult: delivery => {
          sending.resolve(delivery);
          return acknowledgement.promise;
        },
      }
    );
    await operation.done;
    const sealed = await sending.promise;
    let retirement: Promise<RetireDirectoryResult> | undefined;
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      prepare: input => input,
      publish: async () => {
        throw new ControlDeliveryError('rejected', false);
      },
      sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
      onFailure: createControlEventFailureHandler({
        getRuntime: () => runtime,
        onFailure: failure => {
          retirement = registry.retireDirectory(
            failure.publication.session.directory,
            'Session event delivery rejected',
            Date.now() + 30_000,
            target
          );
        },
      }),
    });
    try {
      expect(operation.nativeTarget()).toEqual(target);
      expect(operation.snapshot().delivery?.state).toBe('pending');
      expect(
        transport.enqueue('session.event', payload, {
          ...session,
          nativeRuntimeId: runtime.runtimeId,
        })
      ).toBe(true);
      expect(await transport.resume()).toBe(true);
      expect(await retirement).toBe('retired');
      expect(nativeRetire).toHaveBeenCalledTimes(1);
      expect(nativeRetire).toHaveBeenCalledWith(session.directory, expect.any(Number), target);
      expect(runtime.signal.aborted).toBe(true);
      expect(registry.retained()).toEqual([operation]);
      expect(operation.deliveryResult()).toEqual(sealed);
      expect(operation.snapshot().delivery?.state).toBe('pending');
      acknowledgement.resolve(await acknowledgeOperation(sealed));
      await operation.waitForDelivery();
      expect(operation.snapshot().delivery?.state).toBe('acknowledged');
      expect(operation.deliveryResult()).toEqual(sealed);
    } finally {
      transport.close();
      acknowledgement.resolve(await acknowledgeOperation(sealed));
      await operation.waitForDelivery();
    }
  });

  it('selects the failed native runtime among isolated roots in the same directory', () => {
    const first = { runtimeId: 'native_first' };
    const second = { runtimeId: 'native_second' };
    const retired = mock();
    const getRuntime = mock((directory: string, nativeRuntimeId: string) =>
      directory === session.directory
        ? [first, second].find(runtime => runtime.runtimeId === nativeRuntimeId)
        : undefined
    );
    const handleFailure = createControlEventFailureHandler({ getRuntime, onFailure: retired });
    const failure: ControlEventOutboxFailure = {
      reason: 'expired',
      publication: {
        event: 'session.event',
        receiptId: 'receipt_second',
        sequence: 1,
        session: { ...session, nativeRuntimeId: second.runtimeId },
        payload,
      },
    };
    handleFailure(failure);
    expect(getRuntime).toHaveBeenCalledWith(session.directory, second.runtimeId);
    expect(retired).toHaveBeenCalledWith(failure, second);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it('reports failures without native identity without guessing the current runtime', async () => {
    const retired = mock();
    const getRuntime = mock(() => ({ runtimeId: crypto.randomUUID() }));
    const handleFailure = createControlEventFailureHandler({ getRuntime, onFailure: retired });
    const reported = mock((failure: ControlEventOutboxFailure) => handleFailure(failure));
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      prepare: input => input,
      publish: async () => {
        throw new ControlDeliveryError('rejected', false);
      },
      sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
      onFailure: reported,
    });
    try {
      expect(transport.enqueue('session.event', payload, session)).toBe(true);
      expect(await transport.resume()).toBe(true);
      handleFailure();
      expect(reported).toHaveBeenCalledTimes(1);
      expect(getRuntime).not.toHaveBeenCalled();
      expect(retired).not.toHaveBeenCalled();
    } finally {
      transport.close();
    }
  });

  it('routes a child receipt failure through its root owner while preserving child identity', () => {
    rememberAttachedRoot('root', '/root');
    rememberChildSession({ childId: 'child', parentId: 'root', directory: '/child' });
    const runtime = { runtimeId: 'native-root' };
    const getRuntime = mock((directory: string) => (directory === '/root' ? runtime : undefined));
    const onFailure = mock();
    const handleFailure = createControlEventFailureHandler({ getRuntime, onFailure });
    const failure: ControlEventOutboxFailure = {
      reason: 'rejected',
      publication: {
        event: 'session.event',
        receiptId: 'receipt_child',
        sequence: 1,
        session: {
          directory: '/child',
          kiloSessionId: 'child',
          rootKiloSessionId: 'root',
          nativeRuntimeId: runtime.runtimeId,
        },
        payload,
      },
    };

    handleFailure(failure);

    expect(getRuntime).toHaveBeenCalledWith('/root', runtime.runtimeId);
    expect(onFailure).toHaveBeenCalledWith(failure, runtime);
  });

  it('routes an expired child receipt through the root owner before runtime lookup', () => {
    rememberAttachedRoot('root', '/root');
    rememberChildSession({ childId: 'child_expired', parentId: 'root', directory: '/child' });
    const runtime = { runtimeId: 'native-root' };
    const getRuntime = mock((directory: string) => (directory === '/root' ? runtime : undefined));
    const onFailure = mock();
    const handleFailure = createControlEventFailureHandler({ getRuntime, onFailure });
    const failure: ControlEventOutboxFailure = {
      reason: 'expired',
      publication: {
        event: 'session.event',
        receiptId: 'receipt_child_expired',
        sequence: 2,
        session: {
          directory: '/child',
          kiloSessionId: 'child_expired',
          rootKiloSessionId: 'root',
          nativeRuntimeId: runtime.runtimeId,
        },
        payload,
      },
    };

    handleFailure(failure);

    expect(getRuntime).toHaveBeenCalledWith('/root', runtime.runtimeId);
    expect(onFailure).toHaveBeenCalledWith(failure, runtime);
  });

  it('fails closed for an unresolved child receipt failure', () => {
    rememberAttachedRoot('root', '/root');
    const getRuntime = mock(() => ({ runtimeId: 'native-root' }));
    const onFailure = mock();
    const handleFailure = createControlEventFailureHandler({ getRuntime, onFailure });

    handleFailure({
      reason: 'rejected',
      publication: {
        event: 'session.event',
        receiptId: 'receipt_unknown',
        sequence: 1,
        session: {
          directory: '/child',
          kiloSessionId: 'unknown-child',
          rootKiloSessionId: 'root',
          nativeRuntimeId: 'native-root',
        },
        payload,
      },
    });

    expect(getRuntime).not.toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('legacy publication admission reporting', () => {
  it.each([
    ['disconnected', { sent: false as const, reason: 'disconnected' as const }, 'disconnected'],
    [
      'socket_overflow',
      { sent: false as const, reason: 'socket_overflow' as const },
      'socket_overflow',
    ],
    ['send_failed', { sent: false as const, reason: 'send_failed' as const }, 'send_failed'],
  ] as const)(
    'reports the classified legacy %s failure once through both publication APIs',
    async (_outcome, result, expectedReason) => {
      const admissions: Array<{ event: string; reason: string; directory: string }> = [];
      const sendLegacy = mock(() => result);
      const transport = createControlEventTransport({
        supportsReceipts: () => false,
        publish: async () => {},
        prepare: input => input,
        sendLegacy,
        onFailure: () => {},
        onAdmissionFailure: input =>
          admissions.push({
            event: input.event,
            reason: input.reason,
            directory: input.session.directory,
          }),
      });
      try {
        expect(transport.enqueue('session.event', payload, session)).toBe(false);
        expect(await transport.publishSessionEvent(payload, session)).toBe(false);
        expect(sendLegacy).toHaveBeenCalledTimes(2);
        expect(admissions).toEqual([
          { event: 'session.event', reason: expectedReason, directory: session.directory },
          { event: 'session.event', reason: expectedReason, directory: session.directory },
        ]);
      } finally {
        transport.close();
      }
    }
  );

  it('classifies a thrown legacy send as send_failed through both publication APIs', async () => {
    const admissions: string[] = [];
    const transport = createControlEventTransport({
      supportsReceipts: () => false,
      publish: async () => {},
      prepare: input => input,
      sendLegacy: () => {
        throw new Error('serialize failed');
      },
      onFailure: () => {},
      onAdmissionFailure: input => admissions.push(input.reason),
    });
    try {
      expect(transport.enqueue('session.event', payload, session)).toBe(false);
      expect(await transport.publishSessionEvent(payload, session)).toBe(false);
      expect(admissions).toEqual(['send_failed', 'send_failed']);
    } finally {
      transport.close();
    }
  });

  it('does not report a successful legacy publication', async () => {
    const admissions = mock();
    const transport = createControlEventTransport({
      supportsReceipts: () => false,
      publish: async () => {},
      prepare: input => input,
      sendLegacy: () => ({ sent: true }),
      onFailure: () => {},
      onAdmissionFailure: admissions,
    });
    try {
      expect(transport.enqueue('session.event', payload, session)).toBe(true);
      expect(await transport.publishSessionEvent(payload, session)).toBe(true);
      expect(admissions).not.toHaveBeenCalled();
    } finally {
      transport.close();
    }
  });

  it('does not report a receipt-backed admission failure as a legacy failure', async () => {
    const admissions: string[] = [];
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      publish: async () => {},
      prepare: () => {
        throw new Error('prepare failed');
      },
      sendLegacy: () => ({ sent: true }),
      onFailure: () => {},
      onAdmissionFailure: input => admissions.push(input.reason),
    });
    try {
      expect(transport.enqueue('session.event', payload, session)).toBe(false);
      expect(admissions).toEqual(['prepare_failed']);
    } finally {
      transport.close();
    }
  });
});

describe('receipt-backed producer admission', () => {
  it('holds a producer enqueue while paused and publishes it on resume', async () => {
    const published: ControlEventPublication[] = [];
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      prepare: input => input,
      publish: async publication => {
        published.push(publication);
      },
      sendLegacy: () => ({ sent: false, reason: 'send_failed' }),
      onFailure: () => {},
    });
    try {
      transport.pause();
      expect(await transport.publishSessionEvent(payload, session)).toBe(true);
      expect(published).toHaveLength(0);

      expect(await transport.resume()).toBe(true);
      expect(published).toHaveLength(1);
      expect(published[0]).toMatchObject({
        event: 'session.event',
        receiptId: expect.any(String),
        sequence: 1,
        session,
        payload,
      });
      expect(await transport.resume()).toBe(true);
      expect(published).toHaveLength(1);
    } finally {
      transport.close();
    }
  });
});
