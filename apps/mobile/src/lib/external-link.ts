import * as WebBrowser from 'expo-web-browser';
import { toast } from 'sonner-native';

export async function openExternalUrl(url: string, { label = 'link' }: { label?: string } = {}) {
  try {
    await WebBrowser.openBrowserAsync(url);
  } catch {
    toast.error(`Could not open ${label}`);
  }
}
