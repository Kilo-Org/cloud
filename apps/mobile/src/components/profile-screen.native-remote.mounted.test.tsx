import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findConfigureRows,
  mountProfile,
  organizationsQueryFn,
  providersQueryFn,
  routerPush,
} from './profile-screen.test-helpers';
import { i18n } from '@/i18n';
import { act } from '@/test/renderer';

beforeEach(() => {
  routerPush.mockReset();
  organizationsQueryFn.mockResolvedValue([]);
  providersQueryFn.mockResolvedValue({ providers: [] });
});

// The demo entry pushes through the press-burst guard, and this assertion reads
// the router mock, so the guarded push is that function.
vi.mock('@/lib/hooks/use-single-push-route', () => ({
  useSinglePushRoute: () => routerPush,
}));

describe('Profile native remote demo entry', () => {
  it('is absent in a release bundle', async () => {
    const { renderer, unmount } = await mountProfile();
    expect(findConfigureRows(renderer.root, i18n.t('nativeRemote.title'))).toHaveLength(0);
    unmount();
  });

  it('opens the preview route in a development bundle', async () => {
    vi.stubGlobal('__DEV__', true);
    const { renderer, unmount } = await mountProfile();
    const [row] = findConfigureRows(renderer.root, i18n.t('nativeRemote.title'));
    const onPress = row?.props.onPress as (() => void) | undefined;
    if (!onPress) {
      throw new Error('Native remote entry is missing');
    }
    act(() => {
      onPress();
    });
    expect(routerPush).toHaveBeenCalledWith('/(app)/native-remote');
    unmount();
  });
});
