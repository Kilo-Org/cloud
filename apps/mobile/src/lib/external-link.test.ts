import * as WebBrowser from 'expo-web-browser';
import { type WebBrowserResult } from 'expo-web-browser';
import { Linking } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner-native';

import { openExternalUrl } from './external-link';

// WebBrowserResultType enum cannot be imported as a value here: it is mocked to avoid
// pulling in react-native's Flow-syntax source through vi.mock's module graph.
// eslint-disable-next-line typescript-eslint/consistent-type-assertions -- see above
const OPENED_RESULT = { type: 'opened' } as WebBrowserResult;
const UNSUPPORTED_URL = ['java', 'script:alert(1)'].join('');

vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('react-native', () => ({ Linking: { openURL: vi.fn() } }));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

// Linking.openURL is a Vitest mock assigned above, not a bound instance method.
// eslint-disable-next-line typescript-eslint/unbound-method -- see above
const mockedOpenUrl = vi.mocked(Linking.openURL);

describe('openExternalUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the URL without feedback when the browser succeeds', async () => {
    vi.mocked(WebBrowser.openBrowserAsync).mockResolvedValue(OPENED_RESULT);

    await openExternalUrl('https://kilo.ai');

    expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith('https://kilo.ai');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens non-web URL schemes with the platform handler', async () => {
    mockedOpenUrl.mockResolvedValue(undefined);

    await openExternalUrl('mailto:hello@kilo.ai');

    expect(mockedOpenUrl).toHaveBeenCalledWith('mailto:hello@kilo.ai');
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not dispatch unsupported URL schemes to the platform', async () => {
    await openExternalUrl(UNSUPPORTED_URL, { label: 'link', retryOnError: true });

    expect(mockedOpenUrl).not.toHaveBeenCalled();
    expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith('Could not open link', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
  });

  it('keeps the existing error toast when retry is not requested', async () => {
    vi.mocked(WebBrowser.openBrowserAsync).mockRejectedValue(new Error('browser unavailable'));

    await openExternalUrl('https://kilo.ai', { label: 'Kilo' });

    expect(toast.error).toHaveBeenCalledWith('Could not open Kilo');
  });

  it('retries only the same URL when the retry action is pressed', async () => {
    vi.mocked(WebBrowser.openBrowserAsync)
      .mockRejectedValueOnce(new Error('browser unavailable'))
      .mockResolvedValueOnce(OPENED_RESULT);

    await openExternalUrl('https://kilo.ai/docs', { label: 'link', retryOnError: true });

    expect(toast.error).toHaveBeenCalledWith('Could not open link', {
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    const options = vi.mocked(toast.error).mock.calls[0]?.[1];
    if (!options?.action || typeof options.action !== 'object' || !('onClick' in options.action)) {
      throw new Error('Expected retry action');
    }

    options.action.onClick();
    await vi.waitFor(() => {
      expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(2);
    });
    expect(WebBrowser.openBrowserAsync).toHaveBeenLastCalledWith('https://kilo.ai/docs');
  });
});
