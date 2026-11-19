// The sign-in fixture route: the sign-in screen restores the resumed sign-in
// once, on mount, so it must not mount before the fixture's record is written.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import LoginFixtureRoute from './login-fixture';

const mocks = vi.hoisted(() => ({
  write: vi.fn<(state: string) => Promise<void>>(),
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
vi.mock('@/lib/login-fixture', () => ({
  isLoginFixtureState: (value: string) => value === 'denied',
  writeLoginFixture: mocks.write,
}));

describe('LoginFixtureRoute', () => {
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    mocks.write.mockReset();
  });

  it('mounts the sign-in screen only after the resumed sign-in is written', async () => {
    const write = Promise.withResolvers<undefined>();
    mocks.write.mockReturnValue(write.promise);
    const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
    await act(async () => {
      ref.current = TestRenderer.create(createElement(LoginFixtureRoute));
      await Promise.resolve();
    });
    const renderer = ref.current;
    if (!renderer) {
      throw new Error('route did not render');
    }
    expect(mocks.write).toHaveBeenCalledWith('denied');
    expect(renderer.root.findAllByType(mocks.Login)).toHaveLength(0);
    expect(renderer.root.findAllByType(mocks.Loading)).toHaveLength(1);

    await act(async () => {
      write.resolve(undefined);
      await write.promise;
    });
    expect(renderer.root.findAllByType(mocks.Login)).toHaveLength(1);
  });
});
