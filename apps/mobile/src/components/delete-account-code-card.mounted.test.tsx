import { createElement, useState } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import '@/i18n';
import { DeleteAccountCodeCard } from './delete-account-code-card';
import { type DeleteAccountState, useDeleteAccount } from './use-delete-account';

const challengeFn = vi.hoisted(() => vi.fn());
const executeFn = vi.hoisted(() => vi.fn());
const signOutFn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: {
      requestAccountDeletionChallenge: {
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: challengeFn,
          mutationKey: ['delete-account-challenge'],
        }),
      },
      requestAccountDeletion: {
        mutationOptions: (opts: object) => ({
          ...opts,
          mutationFn: executeFn,
          mutationKey: ['delete-account-execute'],
        }),
      },
    },
  }),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({ signOut: signOutFn }),
}));

vi.mock('sonner-native', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/card', () => ({ Card: 'Card' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type DeleteCodeHostProps = {
  holder: { current: DeleteAccountState | null };
  search: { current: ((active: boolean) => void) | null };
};

/**
 * Mirrors the Profile screen's delete block: the hook and the search branch
 * share one owner, and the code field sits inside the default list, so an
 * active Settings search unmounts it while the hook keeps the entered code and
 * its submit state.
 */
function DeleteCodeHost({ holder, search }: DeleteCodeHostProps) {
  const account = useDeleteAccount();
  const [searchActive, setSearchActive] = useState(false);
  holder.current = account;
  search.current = setSearchActive;
  const showsCode = account.phase === 'awaiting-code' || account.phase === 'executing';
  if (searchActive || !showsCode) {
    return null;
  }
  return createElement(DeleteAccountCodeCard, {
    initialCode: account.code,
    canSubmitCode: account.canSubmitCode,
    executing: account.phase === 'executing',
    onChangeCode: account.setCode,
    onSubmit: account.submitCode,
  });
}

type CodeFieldProps = {
  defaultValue: string | undefined;
  onChangeText: (code: string) => void;
};

type SubmitProps = {
  disabled: boolean;
  onPress: () => void;
};

type DeleteCodeHostHandle = {
  holder: { current: DeleteAccountState | null };
  /** The code field currently on screen; throws when the block is unmounted. */
  field: () => CodeFieldProps;
  /** Every code field currently mounted. */
  fields: () => readonly unknown[];
  submit: () => SubmitProps;
  setActive: (active: boolean) => void;
};

async function mountDeleteCodeHost(): Promise<DeleteCodeHostHandle> {
  const holder: { current: DeleteAccountState | null } = { current: null };
  const search: { current: ((active: boolean) => void) | null } = { current: null };
  const ui = await renderWithProviders(createElement(DeleteCodeHost, { holder, search }));
  const nodes = (type: string) => ui.renderer.root.findAll(node => String(node.type) === type);
  const field = () => {
    const [node] = nodes('FormField');
    if (!node) {
      throw new Error('code field is not rendered');
    }
    return node.props as CodeFieldProps;
  };
  const submit = () => {
    const [node] = nodes('Button');
    if (!node) {
      throw new Error('submit is not rendered');
    }
    return node.props as SubmitProps;
  };
  const setActive = (active: boolean) => {
    act(() => {
      search.current?.(active);
    });
  };
  return { holder, field, fields: () => nodes('FormField'), submit, setActive };
}

function current(holder: { current: DeleteAccountState | null }): DeleteAccountState {
  const result = holder.current;
  if (!result) {
    throw new Error('probe did not render');
  }
  return result;
}

/**
 * Settings search replaces the default list, so an active query unmounts the
 * code field while the hook keeps the entered code and its submit state. The
 * remounted field has to start from that code: an empty field whose submit
 * sends the hidden code is the regression.
 */
describe('DeleteAccountCodeCard', () => {
  beforeEach(() => {
    vi.stubGlobal('__DEV__', false);
    challengeFn.mockReset();
    executeFn.mockReset();
    signOutFn.mockReset();
  });

  it('keeps the typed code visible after Settings search unmounts and remounts the field', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1' });
    executeFn.mockResolvedValue({ status: 'deleted' });
    const host = await mountDeleteCodeHost();

    act(() => {
      current(host.holder).beginDelete();
    });
    await waitFor(() => current(host.holder).phase === 'awaiting-code');
    expect(host.field().defaultValue).toBeUndefined();

    act(() => {
      host.field().onChangeText('482913');
    });

    act(() => {
      host.setActive(true);
    });
    expect(host.fields()).toHaveLength(0);

    act(() => {
      host.setActive(false);
    });
    // The remounted field starts from the code the hook still holds, so the
    // visible value and the submitted value cannot disagree.
    expect(host.field().defaultValue).toBe('482913');

    act(() => {
      host.submit().onPress();
    });
    await waitFor(() => executeFn.mock.calls.length === 1);
    expect(executeFn.mock.calls[0]?.[0]).toEqual({ challengeId: 'challenge-1', code: '482913' });
  });

  it('keeps a cleared field empty after a remount and submits nothing', async () => {
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1' });
    const host = await mountDeleteCodeHost();

    act(() => {
      current(host.holder).beginDelete();
    });
    await waitFor(() => current(host.holder).phase === 'awaiting-code');

    act(() => {
      host.field().onChangeText('482913');
    });
    act(() => {
      host.field().onChangeText('');
    });

    act(() => {
      host.setActive(true);
    });
    act(() => {
      host.setActive(false);
    });

    expect(host.field().defaultValue).toBeUndefined();
    expect(current(host.holder).canSubmitCode).toBe(false);
    expect(host.submit().disabled).toBe(true);

    act(() => {
      host.submit().onPress();
    });
    expect(executeFn).not.toHaveBeenCalled();
  });

  it('starts a dev challenge with the code the server returned', async () => {
    vi.stubGlobal('__DEV__', true);
    challengeFn.mockResolvedValue({ challengeId: 'challenge-1', devCode: '135790' });
    const host = await mountDeleteCodeHost();

    act(() => {
      current(host.holder).beginDelete();
    });
    await waitFor(() => current(host.holder).phase === 'awaiting-code');
    expect(host.field().defaultValue).toBe('135790');

    act(() => {
      host.setActive(true);
    });
    act(() => {
      host.setActive(false);
    });
    expect(host.field().defaultValue).toBe('135790');
  });
});
