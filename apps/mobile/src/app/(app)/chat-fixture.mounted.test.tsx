// The chat fixture route: it starts the fixture chat, then replaces itself with
// the conversation route. A write that fails shows the error with Retry rather
// than holding the loading surface forever.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ChatFixtureRoute from './chat-fixture';

type Place = { readonly chatScope: string; readonly org: { readonly kind: 'personal' } };

const mocks = vi.hoisted(() => {
  const replace = vi.fn();
  const personal: Place = { chatScope: 'me:personal', org: { kind: 'personal' } };
  return {
    replace,
    // The hand-off goes through the stack-safe replace, and `useChatPlace`
    // answers the same object on every render, so the doubles do too, until a
    // test moves the place.
    stackSafeReplace: { replace },
    personal,
    place: { current: personal },
    write: vi.fn<(place: Place, state: string) => Promise<string>>(),
    Loading: () => null,
  };
});
const shown = vi.hoisted((): { retry: (() => void) | undefined } => ({ retry: undefined }));

vi.mock('expo-router', () => ({
  Redirect: () => null,
  useLocalSearchParams: () => ({ state: 'failed' }),
}));
vi.mock('@/lib/navigation/stack-safe-replace', () => ({
  useStackSafeReplace: () => mocks.stackSafeReplace,
}));
vi.mock('@/components/bootstrap-loading-surface', () => ({
  BootstrapLoadingSurface: mocks.Loading,
}));
vi.mock('@/components/query-error', () => ({
  QueryError: ({ onRetry }: { onRetry: () => void }) => {
    shown.retry = onRetry;
    return null;
  },
}));
vi.mock('@/lib/chat/use-chat', () => ({ useChatPlace: () => mocks.place.current }));
vi.mock('@/lib/chat/chat-fixture', () => ({
  isChatFixtureState: (value: string) => value === 'failed',
  writeChatFixture: mocks.write,
}));

/** Lets the fixture write the effect started settle, and the route render what follows. */
async function settle(): Promise<void> {
  const tick = Promise.withResolvers<undefined>();
  setTimeout(() => {
    tick.resolve(undefined);
  }, 0);
  await tick.promise;
}

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(ChatFixtureRoute));
    await settle();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

describe('ChatFixtureRoute', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.replace.mockReset();
    mocks.write.mockReset();
    mocks.place.current = mocks.personal;
    shown.retry = undefined;
  });

  it('opens the conversation the fixture started', async () => {
    mocks.write.mockResolvedValue('ses_fixture');
    await mount();
    expect(mocks.write).toHaveBeenCalledWith(mocks.personal, 'failed');
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(4_chat)/[id]',
      params: { id: 'ses_fixture' },
    });
  });

  it('shows the error with Retry when the write fails, and Retry opens the chat', async () => {
    mocks.write.mockRejectedValueOnce(new Error('database closed'));
    mocks.write.mockResolvedValueOnce('ses_retried');
    const renderer = await mount();
    expect(renderer.root.findAllByType(mocks.Loading)).toHaveLength(0);
    expect(shown.retry).toBeDefined();
    expect(mocks.replace).not.toHaveBeenCalled();

    await act(async () => {
      shown.retry?.();
      await settle();
    });
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(4_chat)/[id]',
      params: { id: 'ses_retried' },
    });
  });

  it('navigates only for the place the route is on when the place moves mid-write', async () => {
    const first = Promise.withResolvers<string>();
    const second = Promise.withResolvers<string>();
    mocks.write.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const renderer = await mount();
    const organization: Place = { chatScope: 'me:org-1', org: { kind: 'personal' } };

    await act(async () => {
      mocks.place.current = organization;
      renderer.update(createElement(ChatFixtureRoute));
      await settle();
    });
    expect(mocks.write).toHaveBeenLastCalledWith(organization, 'failed');

    await act(async () => {
      second.resolve('ses_current');
      first.resolve('ses_previous');
      await settle();
    });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith({
      pathname: '/(app)/(tabs)/(4_chat)/[id]',
      params: { id: 'ses_current' },
    });
  });

  it('neither navigates nor shows a failure once the route unmounted', async () => {
    const write = Promise.withResolvers<string>();
    mocks.write.mockReturnValueOnce(write.promise);
    const renderer = await mount();
    act(() => {
      renderer.unmount();
    });
    await act(async () => {
      write.reject(new Error('database closed'));
      await settle();
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(shown.retry).toBeUndefined();
  });
});
