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

function makeDeps(
  overrides: Partial<{
    fetchInstallPayload: DispatchInstallFromSourceDeps['fetchInstallPayload'];
    getActiveInstance: DispatchInstallFromSourceDeps['getActiveInstance'];
    postMessageAsUser: DispatchInstallFromSourceDeps['postMessageAsUser'];
  }> = {}
): DispatchInstallFromSourceDeps {
  return {
    fetchInstallPayload: overrides.fetchInstallPayload ?? (async () => VALID_PAYLOAD),
    getActiveInstance: overrides.getActiveInstance ?? (async () => ACTIVE_INSTANCE),
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

const ARGS = { userId: 'user-1', source: 'byte' as const, slug: 'deep-research' };

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

    expect(fetchSpy).toHaveBeenCalledWith('byte', 'deep-research');
    expect(instanceSpy).toHaveBeenCalledWith('user-1');
    expect(dispatchSpy).toHaveBeenCalledWith({
      userId: 'user-1',
      sandboxId: 'sb-1',
      message: 'Research [topic] for me.',
      source: 'install',
      autoCreateConversation: true,
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
