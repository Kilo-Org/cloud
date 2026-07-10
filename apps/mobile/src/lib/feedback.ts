import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import * as StoreReview from 'expo-store-review';
import { Alert, Linking, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { REVIEW_REQUESTED_AT_KEY } from '@/lib/storage-keys';

const SUPPORT_EMAIL = 'hi@kilo.ai';

const STORE_REVIEW_URL = Platform.select({
  ios: 'https://apps.apple.com/app/id6761193135?action=write-review',
  default: 'https://play.google.com/store/apps/details?id=com.kilocode.kiloapp',
});

async function openSupportEmail(userId: string | undefined) {
  const envDetails = [
    `User ID: ${userId ?? 'unknown'}`,
    `App version: ${Application.nativeApplicationVersion} (${Application.nativeBuildVersion})`,
    `OS: ${Platform.OS} ${Platform.Version}`,
  ].join('\n');
  const body = `\n\n---\n${envDetails}`;
  const url = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('mobile app feedback')}&body=${encodeURIComponent(body)}`;
  try {
    await Linking.openURL(url);
  } catch {
    toast.error(`No email app available. You can reach us at ${SUPPORT_EMAIL}`);
  }
}

async function rateApp() {
  // The native review popup silently no-ops when the OS rate limit is hit, so
  // only use it the first time; afterwards deep-link to the store review page.
  try {
    const alreadyRequested = await SecureStore.getItemAsync(REVIEW_REQUESTED_AT_KEY);
    if (alreadyRequested == null && (await StoreReview.isAvailableAsync())) {
      await SecureStore.setItemAsync(REVIEW_REQUESTED_AT_KEY, new Date().toISOString());
      await StoreReview.requestReview();
      return;
    }
  } catch {
    // Native popup path failed — fall through to the store page.
  }
  try {
    await Linking.openURL(STORE_REVIEW_URL);
  } catch {
    toast.error('Could not open the store.');
  }
}

export function showFeedbackPrompt(userId: string | undefined) {
  Alert.alert('How are you liking the Kilo app?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'I like it',
      onPress: () => {
        Alert.alert(
          "We're glad to hear that!",
          'A store review would help us out immensely. Thanks for using Kilo!',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Rate Kilo',
              onPress: () => {
                void rateApp();
              },
            },
          ]
        );
      },
    },
    {
      text: 'Needs work',
      onPress: () => {
        Alert.alert(
          "We're sorry to hear that!",
          'Please let us know what needs to be better. The engineer in charge of the app reads every single report!',
          [
            { text: 'Not now', style: 'cancel' },
            {
              text: 'Email us',
              onPress: () => {
                void openSupportEmail(userId);
              },
            },
          ]
        );
      },
    },
  ]);
}
