/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts hooks in the node Vitest environment */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type NativeTokenPair } from '@kilocode/app-shared/native-auth';

import { clearLoginDrafts } from '@/lib/login-draft';
import { useDeviceApprovalPersistence } from './use-device-approval-persistence';

vi.mock('@/lib/login-draft', () => ({ clearLoginDrafts: vi.fn() }));

const credentials = { token: 'device-token' } satisfies NativeTokenPair;

type Persistence = ReturnType<typeof useDeviceApprovalPersistence>;

type HarnessProps = {
  signIn: (pair: NativeTokenPair) => Promise<boolean>;
  resultRef: { current: Persistence | null };
  credentials: NativeTokenPair;
};

function Harness({ signIn, resultRef, credentials: approvedCredentials }: HarnessProps): null {
  resultRef.current = useDeviceApprovalPersistence({
    status: 'approved',
    credentials: approvedCredentials,
    signIn,
    couldNotCompleteSignIn: 'Could not complete sign-in.',
  });
  return null;
}

async function mountPersistence(signIn: (pair: NativeTokenPair) => Promise<boolean>) {
  const resultRef: { current: Persistence | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness, { signIn, resultRef, credentials }));
    await Promise.resolve();
  });
  return {
    resultRef,
    updateCredentials: async (nextCredentials: NativeTokenPair) => {
      await act(async () => {
        renderer?.update(
          createElement(Harness, { signIn, resultRef, credentials: nextCredentials })
        );
        await Promise.resolve();
      });
    },
    unmount: () => renderer?.unmount(),
  };
}

describe('useDeviceApprovalPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not queue a manual retry while automatic persistence is in flight', async () => {
    const signInResult = Promise.withResolvers<boolean>();
    const signIn = vi.fn(async () => {
      const result = await signInResult.promise;
      return result;
    });
    const { resultRef, unmount } = await mountPersistence(signIn);

    expect(signIn).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.isPersisting).toBe(true);
    await act(async () => {
      await Promise.all([
        resultRef.current?.persistToken(credentials),
        resultRef.current?.persistToken(credentials),
      ]);
    });
    expect(signIn).toHaveBeenCalledTimes(1);

    await act(async () => {
      signInResult.resolve(true);
      await signInResult.promise;
    });
    expect(clearLoginDrafts).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('allows retry after a rejected persistence attempt and clears drafts only on success', async () => {
    const signIn = vi
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValueOnce(true);
    const { resultRef, unmount } = await mountPersistence(signIn);

    await vi.waitFor(() => {
      expect(resultRef.current?.persistError).toBe('Could not complete sign-in.');
    });
    expect(clearLoginDrafts).not.toHaveBeenCalled();

    await act(async () => {
      await resultRef.current?.persistToken(credentials);
    });
    expect(signIn).toHaveBeenCalledTimes(2);
    expect(clearLoginDrafts).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps the login draft when sign-in resolves without publishing credentials', async () => {
    const signIn = vi.fn().mockResolvedValue(false);
    const { resultRef, unmount } = await mountPersistence(signIn);

    await vi.waitFor(() => {
      expect(resultRef.current?.persistError).toBe('Could not complete sign-in.');
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(clearLoginDrafts).not.toHaveBeenCalled();
    unmount();
  });

  it('persists replacement credentials after the in-flight original succeeds', async () => {
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const replacement = { token: 'replacement-token' } satisfies NativeTokenPair;
    const signIn = vi
      .fn()
      .mockImplementationOnce(async () => {
        const result = await first.promise;
        return result;
      })
      .mockImplementationOnce(async () => {
        const result = await second.promise;
        return result;
      });
    const { resultRef, updateCredentials, unmount } = await mountPersistence(signIn);

    await updateCredentials(replacement);
    expect(signIn).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve(true);
      await first.promise;
    });
    await vi.waitFor(() => {
      expect(signIn).toHaveBeenCalledTimes(2);
    });
    expect(signIn).toHaveBeenLastCalledWith(replacement);
    expect(clearLoginDrafts).not.toHaveBeenCalled();

    await act(async () => {
      second.resolve(true);
      await second.promise;
    });
    expect(resultRef.current?.isPersisting).toBe(false);
    expect(clearLoginDrafts).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('persists replacement credentials after the in-flight original fails', async () => {
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const replacement = { token: 'replacement-token' } satisfies NativeTokenPair;
    const signIn = vi
      .fn()
      .mockImplementationOnce(async () => {
        const result = await first.promise;
        return result;
      })
      .mockImplementationOnce(async () => {
        const result = await second.promise;
        return result;
      });
    const { resultRef, updateCredentials, unmount } = await mountPersistence(signIn);

    await updateCredentials(replacement);
    await act(async () => {
      first.reject(new Error('write failed'));
      try {
        await first.promise;
      } catch {
        // The hook handles the failed original attempt before continuing with the replacement.
      }
    });
    await vi.waitFor(() => {
      expect(signIn).toHaveBeenCalledTimes(2);
    });
    expect(signIn).toHaveBeenLastCalledWith(replacement);
    expect(resultRef.current?.persistError).toBeUndefined();

    await act(async () => {
      second.resolve(true);
      await second.promise;
    });
    expect(resultRef.current?.isPersisting).toBe(false);
    expect(clearLoginDrafts).toHaveBeenCalledTimes(1);
    unmount();
  });
});
