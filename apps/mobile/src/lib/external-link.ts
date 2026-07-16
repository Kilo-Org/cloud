import * as WebBrowser from 'expo-web-browser';
import { toast } from 'sonner-native';

type ExternalLinkOptions = {
  label?: string;
  retryOnError?: boolean;
};

export async function openExternalUrl(
  url: string,
  { label = 'link', retryOnError = false }: ExternalLinkOptions = {}
) {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    const message = `Could not open ${label}`;
    if (!retryOnError) {
      toast.error(message);
      return;
    }

    toast.error(message, {
      action: {
        label: 'Try again',
        onClick: () => {
          void openExternalUrl(url, { label, retryOnError: true });
        },
      },
    });
  }
}
