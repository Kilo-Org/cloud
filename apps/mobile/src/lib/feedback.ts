import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import * as StoreReview from 'expo-store-review';
import { Alert, Linking, Platform } from 'react-native';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { captureEvent, FEEDBACK_SUBMITTED_EVENT } from '@/lib/analytics/posthog';
import { writeAccountMetadata } from '@/lib/auth/account-metadata-write';
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
    toast.error(i18n.t('feedback.noEmailApp', { email: SUPPORT_EMAIL }));
  }
}

// Serialized claim of the one-time native review request. The marker
// absent-check and the marker write run inside one per-key chain (the shared
// metadata helper), so concurrent `rateApp` calls observe the marker
// atomically: exactly one call sees it absent, writes it, and returns true;
// later calls see it and fall back to the store page.
async function claimOneTimeReview(): Promise<boolean> {
  let claimed = false;
  await writeAccountMetadata(REVIEW_REQUESTED_AT_KEY, async () => {
    const alreadyRequested = await SecureStore.getItemAsync(REVIEW_REQUESTED_AT_KEY);
    if (alreadyRequested != null) {
      return;
    }
    if (await StoreReview.isAvailableAsync()) {
      claimed = true;
      await SecureStore.setItemAsync(REVIEW_REQUESTED_AT_KEY, new Date().toISOString());
    }
  });
  return claimed;
}

async function rateApp() {
  // The native review popup silently no-ops when the OS rate limit is hit, so
  // only use it the first time; afterwards deep-link to the store review page.
  try {
    if (await claimOneTimeReview()) {
      await StoreReview.requestReview();
      return;
    }
  } catch {
    // Native popup path failed — fall through to the store page.
  }
  try {
    await Linking.openURL(STORE_REVIEW_URL);
  } catch {
    toast.error(i18n.t('feedback.couldNotOpenStore'));
  }
}

export function showFeedbackPrompt(userId: string | undefined) {
  Alert.alert(i18n.t('feedback.promptTitle'), undefined, [
    { text: i18n.t('common.cancel'), style: 'cancel' },
    {
      text: i18n.t('feedback.iLikeIt'),
      onPress: () => {
        captureEvent(FEEDBACK_SUBMITTED_EVENT, { sentiment: 'positive' });
        Alert.alert(i18n.t('feedback.gladTitle'), i18n.t('feedback.gladMessage'), [
          { text: i18n.t('common.notNow'), style: 'cancel' },
          {
            text: i18n.t('feedback.rateKilo'),
            onPress: () => {
              void rateApp();
            },
          },
        ]);
      },
    },
    {
      text: i18n.t('feedback.needsWork'),
      onPress: () => {
        captureEvent(FEEDBACK_SUBMITTED_EVENT, { sentiment: 'negative' });
        Alert.alert(i18n.t('feedback.sorryTitle'), i18n.t('feedback.sorryMessage'), [
          { text: i18n.t('common.notNow'), style: 'cancel' },
          {
            text: i18n.t('feedback.emailUs'),
            onPress: () => {
              void openSupportEmail(userId);
            },
          },
        ]);
      },
    },
  ]);
}
