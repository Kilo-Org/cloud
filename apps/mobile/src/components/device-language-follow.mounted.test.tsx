import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceLanguageFollow } from '@/components/device-language-follow';
import { renderWithProviders } from '@/test/render-with-providers';

const state = vi.hoisted(() => ({
  locales: [{ languageTag: 'en-US' }] as { languageTag: string }[],
  requestDeviceLanguageFollow: vi.fn(),
}));

vi.mock('expo-localization', () => ({ useLocales: () => state.locales }));
vi.mock('@/i18n/device-language-follow', () => ({
  requestDeviceLanguageFollow: state.requestDeviceLanguageFollow,
}));

describe('DeviceLanguageFollow', () => {
  beforeEach(() => {
    state.locales = [{ languageTag: 'en-US' }];
    state.requestDeviceLanguageFollow.mockReset();
  });

  it('follows the language a device locale change resolves to', async () => {
    const { renderer, unmount } = await renderWithProviders(<DeviceLanguageFollow enabled />);
    expect(state.requestDeviceLanguageFollow.mock.calls).toEqual([['en']]);

    await act(() => {
      state.locales = [{ languageTag: 'ar-EG' }, { languageTag: 'en-US' }];
      renderer.update(<DeviceLanguageFollow enabled />);
    });

    expect(state.requestDeviceLanguageFollow.mock.calls).toEqual([['en'], ['ar']]);
    unmount();
  });

  it('follows nothing until the startup language apply has finished', async () => {
    const { renderer, unmount } = await renderWithProviders(
      <DeviceLanguageFollow enabled={false} />
    );
    expect(state.requestDeviceLanguageFollow).not.toHaveBeenCalled();

    await act(() => {
      state.locales = [{ languageTag: 'de-DE' }];
      renderer.update(<DeviceLanguageFollow enabled />);
    });

    expect(state.requestDeviceLanguageFollow.mock.calls).toEqual([['de']]);
    unmount();
  });
});
