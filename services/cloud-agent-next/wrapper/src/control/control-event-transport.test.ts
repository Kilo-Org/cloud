import { describe, expect, it, mock, spyOn } from 'bun:test';
import {
  createControlEventFailureHandler,
  createControlEventTransport,
} from './control-event-transport';
import type { ControlEventOutboxFailure, ControlEventPublication } from './control-event-outbox';
import { ControlDeliveryError } from './sandbox-control-client';
import { createOperationRegistry } from './operation-registry';
import { acknowledgeOperation, fakeKilo, operationAuthorization } from './control-test-fixtures';
import type {
  SessionOperationAck,
  SessionOperationDelivery,
} from '../../../src/shared/sandbox-control-protocol';
import type { NativeRetirement } from './session-operation-cleanup';

const session = {
  directory: '/workspace',
  kiloSessionId: 'ses_root',
  rootKiloSessionId: 'ses_root',
};
const payload = { type: 'session.idle', properties: {} };

describe('native-scoped control event failures', () => {
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
        sendLegacy: () => false,
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
        if (reason === 'expired') clock.mockReturnValue(31_000);
        expect(await transport.resume()).toBe(true);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          reason,
          publication: { sequence: 1, session: { ...session, nativeRuntimeId: originalNativeId } },
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

  it('coalesces retirement of the failed native lifetime without poisoning its replacement', async () => {
    const original = { runtimeId: crypto.randomUUID() };
    let current = original;
    const retired = mock();
    const handleFailure = createControlEventFailureHandler({
      getRuntime: () => current,
      onFailure: retired,
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
      sendLegacy: () => false,
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
      expect(retired).toHaveBeenCalledTimes(1);
      expect(retired).toHaveBeenCalledWith(failures[0], original);
      current = { runtimeId: crypto.randomUUID() };
      expect(
        await transport.publishSessionEvent(payload, {
          ...session,
          nativeRuntimeId: current.runtimeId,
        })
      ).toBe(true);
      expect(await transport.resume()).toBe(true);
      expect(published.at(-1)?.session.nativeRuntimeId).toBe(current.runtimeId);
      expect(retired).toHaveBeenCalledTimes(1);
      const failure = failures[0];
      if (!failure) throw new Error('Missing native failure');
      handleFailure(failure);
      handleFailure({
        ...failure,
        publication: {
          ...failure.publication,
          session: { ...session, nativeRuntimeId: current.runtimeId },
        },
      });
      expect(retired).toHaveBeenCalledTimes(2);
      expect(retired.mock.calls[1]?.[1]).toBe(current);
    } finally {
      transport.close();
    }
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
    let retirement: Promise<NativeRetirement> | undefined;
    const transport = createControlEventTransport({
      supportsReceipts: () => true,
      prepare: input => input,
      publish: async () => {
        throw new ControlDeliveryError('rejected', false);
      },
      sendLegacy: () => false,
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
      sendLegacy: () => false,
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
});
