import { describe, expect, it, vi } from 'vitest';

import { launchImagePicker } from './image-picker';

const toastMock = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: toastMock.error, success: vi.fn(), warning: vi.fn() },
}));

type LaunchResult = Awaited<Parameters<typeof launchImagePicker>[0]>;

const ASSET = { uri: 'file:///photo.jpg', height: 1, width: 1 };

async function resolving(result: LaunchResult): Promise<LaunchResult> {
  await Promise.resolve();
  return result;
}

describe('launchImagePicker', () => {
  it('returns the picked assets', async () => {
    const assets = await launchImagePicker(resolving({ canceled: false, assets: [ASSET] }));

    expect(assets).toEqual([ASSET]);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('returns nothing and stays quiet when the user cancels', async () => {
    const assets = await launchImagePicker(resolving({ canceled: true, assets: null }));

    expect(assets).toEqual([]);
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  // Android unregisters the picker's ActivityResultLauncher when the launching
  // Activity is destroyed, so every later launch rejects until the process
  // restarts. The user must hear about it instead of getting a silent no-op.
  it('toasts a recovery hint when the native launch rejects', async () => {
    toastMock.error.mockClear();

    const assets = await launchImagePicker(
      Promise.reject(new Error('Attempting to launch an unregistered ActivityResultLauncher'))
    );

    expect(assets).toEqual([]);
    expect(toastMock.error).toHaveBeenCalledWith(
      'Could not open the photo picker. Restart Kilo and try again.'
    );
  });
});
