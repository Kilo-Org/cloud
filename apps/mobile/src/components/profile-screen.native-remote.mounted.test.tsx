import { beforeEach, describe, expect, it } from 'vitest';
import {
  findConfigureRows,
  mountProfile,
  nativeRemoteFlag,
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

describe('Profile native remote demo entry', () => {
  it('is absent while the client-only flag is off', async () => {
    const { renderer, unmount } = await mountProfile();
    expect(findConfigureRows(renderer.root, i18n.t('nativeRemote.title'))).toHaveLength(0);
    unmount();
  });

  it('opens the gated demo route when the flag is on', async () => {
    nativeRemoteFlag.enabled = true;
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
