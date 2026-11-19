// The sign-in fixture route: the sign-in screen restores the resumed sign-in
// once, on mount, so it must not mount before the fixture's record is written,
// and a signed-in app must never get a record its next sign-in would restore.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LoginFixtureRoute from './login-fixture';

const mocks = vi.hoisted(() => ({
  write: vi.fn<(state: string) => Promise<void>>(),
  auth: { token: undefined as string | undefined, isLoading: false },
  Loading: () => null,
  Login: () => null,
}));

vi.mock('expo-router', () => ({
  Redirect: () => null,
  useLocalSearchParams: () => ({ state: 'denied' }),
}));
vi.mock('@/components/bootstrap-loading-surface', () => ({
  BootstrapLoadingSurface: mocks.Loading,
}));
vi.mock('@/components/login-screen', () => ({ LoginScreen: mocks.Login }));
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/login-fixture', () => ({
  isLoginFixtureState: (value: string) => value === 'denied',
  writeLoginFixture: mocks.write,
}));

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(createElement(LoginFixtureRoute));
    await Promise.resolve();
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  return ref.current;
}

describe('LoginFixtureRoute', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.write.mockReset();
    mocks.auth = { token: undefined, isLoading: false };
  });

  it('mounts the sign-in screen only after the resumed sign-in is written', async () => {
    const write = Promise.withResolvers<undefined>();
    mocks.write.mockReturnValue(write.promise);
    const renderer = await mount();
    expect(mocks.write).toHaveBeenCalledWith('denied');
    expect(renderer.root.findAllByType(mocks.Login)).toHaveLength(0);
    expect(renderer.root.findAllByType(mocks.Loading)).toHaveLength(1);

    await act(async () => {
      write.resolve(undefined);
      await write.promise;
    });
    expect(renderer.root.findAllByType(mocks.Login)).toHaveLength(1);
  });

  it('writes nothing while the stored session is read, or when the app is signed in', async () => {
    mocks.auth = { token: undefined, isLoading: true };
    await mount();
    mocks.auth = { token: 'signed-in', isLoading: false };
    const renderer = await mount();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(mocks.Login)).toHaveLength(0);
  });
});
