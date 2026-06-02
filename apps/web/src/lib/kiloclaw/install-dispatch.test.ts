import { TRPCError } from '@trpc/server';
import { dispatchInstallFromSource } from './install-dispatch';
import type { DispatchInstallFromSourceDeps } from './install-dispatch';
import type { InstallPayload } from './install';
import type { PostMessageAsUserResult } from '@kilocode/kilo-chat';

const VALID_PAYLOAD: InstallPayload = {
  slug: 'deep-research',
  title: 'Source Hunter',
  description: 'Deep research that finds primary sources.',
  prompt: 'Research [topic] for me.',
  signature: 'sig-base64',
  signatureKeyId: 'kid-abc',
  signedAt: '2026-05-28T00:00:00.000Z',
  signatureVersion: 1,
};

const ACTIVE_INSTANCE = {
  id: 'instance-1',
  userId: 'user-1',
  sandboxId: 'sb-1',
} as unknown as Awaited<ReturnType<DispatchInstallFromSourceDeps['getActiveInstance']>>;

const RUNTIME_SANDBOX_ID = 'ki_runtime_sandbox';

function makeDeps(
  overrides: Partial<DispatchInstallFromSourceDeps> = {}
): DispatchInstallFromSourceDeps {
  return {
    fetchInstallPayload: overrides.fetchInstallPayload ?? (async () => VALID_PAYLOAD),
    getActiveInstance: overrides.getActiveInstance ?? (async () => ACTIVE_INSTANCE),
    resolveRuntimeSandboxId: overrides.resolveRuntimeSandboxId ?? (async () => RUNTIME_SANDBOX_ID),
    requireKiloClawAccessAtInstance: overrides.requireKiloClawAccessAtInstance ?? (async () => {}),
    postMessageAsUser:
      overrides.postMessageAsUser ??
      (async () =>
        ({
          ok: true,
          conversationId: 'conv-1',
          messageId: 'msg-1',
          conversationCreated: false,
        }) satisfies PostMessageAsUserResult),
  };
}

const ARGS = {
  userId: 'user-1',
  source: 'byte' as const,
  slug: 'deep-research',
  expectedSignature: VALID_PAYLOAD.signature,
};

describe('dispatchInstallFromSource', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('happy path: fetches, looks up instance, dispatches, returns ok', async () => {
    const fetchSpy = jest.fn(async () => VALID_PAYLOAD);
    const instanceSpy = jest.fn(async () => ACTIVE_INSTANCE);
    const dispatchSpy = jest.fn(
      async () =>
        ({
          ok: true,
          conversationId: 'conv-1',
          messageId: 'msg-1',
          conversationCreated: true,
        }) satisfies PostMessageAsUserResult
    );
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const result = await dispatchInstallFromSource(
      ARGS,
      makeDeps({
        fetchInstallPayload: fetchSpy,
        getActiveInstance: instanceSpy,
        postMessageAsUser: dispatchSpy,
      })
    );

    expect(result).toEqual({
      ok: true,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      conversationCreated: true,
    });

    // Dispatch re-fetches uncached so a changed/revoked/deleted byte is seen.
    expect(fetchSpy).toHaveBeenCalledWith('byte', 'deep-research', { bypassCache: true });
    expect(instanceSpy).toHaveBeenCalledWith('user-1');
    expect(dispatchSpy).toHaveBeenCalledWith({
      userId: 'user-1',
      sandboxId: RUNTIME_SANDBOX_ID, // NOT the registry row's sandboxId
      message: 'Research [topic] for me.',
      source: 'install',
      forceNewConversation: true, // each install gets its own conversation
      correlation: { reason: 'clawbyte:deep-research' },
    });

    // Audit log emitted with the signing/dispatch fields.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(infoSpy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      event: 'install_dispatched',
      userId: 'user-1',
      source: 'byte',
      slug: 'deep-research',
      signatureKeyId: 'kid-abc',
      signedAt: '2026-05-28T00:00:00.000Z',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      conversationCreated: true,
    });
    expect(logged.dispatchedAt).toEqual(expect.any(String));
  });

  it('throws NOT_FOUND when fetchInstallPayload returns null', async () => {
    await expect(
      dispatchInstallFromSource(ARGS, makeDeps({ fetchInstallPayload: async () => null }))
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws CONFLICT (and does NOT dispatch) when the re-fetched signature differs', async () => {
    const dispatchSpy = jest.fn();
    // Re-fetched payload is a newer, still-validly-signed version (different
    // signature) than the one the user reviewed.
    const changed: InstallPayload = { ...VALID_PAYLOAD, signature: 'different-sig' };
    await expect(
      dispatchInstallFromSource(
        ARGS,
        makeDeps({
          fetchInstallPayload: async () => changed,
          postMessageAsUser: dispatchSpy as never,
        })
      )
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('returns no_instance (and does NOT dispatch) when user has no active instance', async () => {
    const dispatchSpy = jest.fn();
    const result = await dispatchInstallFromSource(
      ARGS,
      makeDeps({
        getActiveInstance: async () => null,
        postMessageAsUser: dispatchSpy as never,
      })
    );

    expect(result).toEqual({ ok: false, code: 'no_instance' });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('fails closed (and does NOT dispatch) when the resolved instance is not entitled', async () => {
    // clawAccessProcedure passed, but the resolved instance is not entitled
    // (inconsistent billing anchor). The per-instance check throws.
    const dispatchSpy = jest.fn();
    const resolveSpy = jest.fn(async () => RUNTIME_SANDBOX_ID);
    await expect(
      dispatchInstallFromSource(
        ARGS,
        makeDeps({
          requireKiloClawAccessAtInstance: async () => {
            throw new TRPCError({ code: 'FORBIDDEN', message: 'not entitled' });
          },
          resolveRuntimeSandboxId: resolveSpy,
          postMessageAsUser: dispatchSpy as never,
        })
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Refused before resolving the sandbox or dispatching.
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('uses the runtime sandbox id, not the registry row, to dispatch', async () => {
    jest.spyOn(console, 'info').mockImplementation(() => {});

    // Make the registry row carry a legacy sandbox id; the resolver returns
    // the modern ki_<instanceId> value the active worker/chat are keyed on.
    const LEGACY_REGISTRY_SANDBOX = 'legacy_userbase64_sandbox';
    const MODERN_RUNTIME_SANDBOX = 'ki_active_runtime_sandbox';
    const halfMigratedInstance = {
      ...ACTIVE_INSTANCE!,
      sandboxId: LEGACY_REGISTRY_SANDBOX,
    } as typeof ACTIVE_INSTANCE;

    let dispatchedWith: Parameters<DispatchInstallFromSourceDeps['postMessageAsUser']>[0] | null =
      null;
    const dispatchSpy: DispatchInstallFromSourceDeps['postMessageAsUser'] = async params => {
      dispatchedWith = params;
      return {
        ok: true,
        conversationId: 'conv-x',
        messageId: 'msg-x',
        conversationCreated: false,
      } satisfies PostMessageAsUserResult;
    };

    await dispatchInstallFromSource(
      ARGS,
      makeDeps({
        getActiveInstance: async () => halfMigratedInstance,
        resolveRuntimeSandboxId: async () => MODERN_RUNTIME_SANDBOX,
        postMessageAsUser: dispatchSpy,
      })
    );

    expect(dispatchedWith).not.toBeNull();
    expect(dispatchedWith!.sandboxId).toBe(MODERN_RUNTIME_SANDBOX);
    expect(dispatchedWith!.sandboxId).not.toBe(LEGACY_REGISTRY_SANDBOX);
  });

  it('returns no_instance when runtime sandbox id resolves to null', async () => {
    // Instance row exists but the runtime status reports no sandbox yet
    // (e.g. provisioning still warming up). Surface this as the same UX
    // class as no-instance so the client lands on /claw/new and re-tries.
    const dispatchSpy = jest.fn();
    const result = await dispatchInstallFromSource(
      ARGS,
      makeDeps({
        resolveRuntimeSandboxId: async () => null,
        postMessageAsUser: dispatchSpy as never,
      })
    );

    expect(result).toEqual({ ok: false, code: 'no_instance' });
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('maps kilo-chat no_conversation to typed no_instance result', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await dispatchInstallFromSource(
      ARGS,
      makeDeps({
        postMessageAsUser: async () =>
          ({
            ok: false,
            code: 'no_conversation',
            error: 'user has no conversation',
          }) satisfies PostMessageAsUserResult,
      })
    );
    expect(result).toEqual({ ok: false, code: 'no_instance' });
    expect(errSpy).toHaveBeenCalled();
  });

  it('throws INTERNAL_SERVER_ERROR on kilo-chat forbidden (auth misconfig)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      dispatchInstallFromSource(
        ARGS,
        makeDeps({
          postMessageAsUser: async () =>
            ({ ok: false, code: 'forbidden', error: 'bad key' }) satisfies PostMessageAsUserResult,
        })
      )
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('throws INTERNAL_SERVER_ERROR on kilo-chat internal/timeout error', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      dispatchInstallFromSource(
        ARGS,
        makeDeps({
          postMessageAsUser: async () =>
            ({
              ok: false,
              code: 'internal',
              error: 'timed out',
            }) satisfies PostMessageAsUserResult,
        })
      )
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('throws INTERNAL_SERVER_ERROR on kilo-chat invalid_request', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      dispatchInstallFromSource(
        ARGS,
        makeDeps({
          postMessageAsUser: async () =>
            ({
              ok: false,
              code: 'invalid_request',
              error: 'message empty',
            }) satisfies PostMessageAsUserResult,
        })
      )
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('rethrown TRPCError keeps the original code', async () => {
    // Sanity check: we use TRPCError so callers can inspect .code.
    let caught: TRPCError | undefined;
    try {
      await dispatchInstallFromSource(ARGS, makeDeps({ fetchInstallPayload: async () => null }));
    } catch (err) {
      caught = err as TRPCError;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect(caught?.code).toBe('NOT_FOUND');
  });
});
