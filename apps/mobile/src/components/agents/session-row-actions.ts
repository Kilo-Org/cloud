import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { toast } from 'sonner-native';

export async function copySessionId(sessionId: string) {
  try {
    const copied = await Clipboard.setStringAsync(sessionId);
    if (!copied) {
      throw new Error('Clipboard rejected session ID');
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success('Session ID copied');
  } catch {
    toast.error('Could not copy session ID');
  }
}
