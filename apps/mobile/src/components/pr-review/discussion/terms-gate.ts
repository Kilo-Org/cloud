// The UGC Terms gate shared by the PR review reply, comment, and edit
// surfaces. Extracted from reply-input.tsx so that component stays under the
// max-lines budget (apps/mobile/.oxlintrc.json); reply-input re-exports
// `ensureTermsAcceptedOutcome` so every existing importer is unchanged.

import { Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { UGC_AGE_POSTURE } from '@kilocode/app-shared/moderation';

import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { classifyPrReviewMutationError } from '@/lib/pr-review/classify-pr-review-query-state';
import { trpcClient } from '@/lib/trpc';

/**
 * Outcome of the UGC Terms gate. `accepted` means the current version is
 * already accepted or the user accepted now (the caller may post).
 * `dismissed` means the user cancelled the gate. `outdated` means the accept
 * was rejected because the version is stale — terminal, the caller must not
 * post. `unknown` means the Terms status could not be read, so acceptance is
 * unconfirmed.
 */
export type TermsGateOutcome =
  | { kind: 'accepted' }
  | { kind: 'dismissed' }
  | { kind: 'outdated' }
  | { kind: 'unknown' };

/**
 * Best-effort UGC Terms gate. Returns `accepted` when the current version is
 * already accepted, or when the user accepts now. A transient accept failure
 * re-prompts with a Retry CTA; an outdated-version reject returns `outdated`
 * (terminal). A `getTermsStatus` failure returns `unknown`: the write may still
 * be attempted (the server enforces Terms), but a pending Terms error must stay
 * visible instead of being cleared as if acceptance was confirmed.
 */
export async function ensureTermsAcceptedOutcome(): Promise<TermsGateOutcome> {
  try {
    const status = await trpcClient.moderation.getTermsStatus.query();
    if (status.accepted) {
      return { kind: 'accepted' };
    }
    return await promptTermsAcceptance(status.currentVersion);
  } catch {
    return { kind: 'unknown' };
  }
}

async function promptTermsAcceptance(version: string): Promise<TermsGateOutcome> {
  const outcome = await new Promise<TermsGateOutcome>(resolve => {
    async function accept() {
      try {
        await trpcClient.moderation.acceptTerms.mutate({
          version,
          agePosture: UGC_AGE_POSTURE,
        });
        resolve({ kind: 'accepted' });
      } catch (error) {
        // A BAD_REQUEST reject is the server's stale-version marker: terminal.
        // Anything else (network, 5xx) is transient and re-prompts with Retry.
        if (classifyPrReviewMutationError(error).kind === 'bad-request') {
          resolve({ kind: 'outdated' });
        } else {
          showRetry();
        }
      }
    }
    function showRetry() {
      Alert.alert(
        i18n.t('prReview.discussion.termsTitle'),
        i18n.t('prReview.discussion.termsAcceptRetry'),
        [
          {
            text: i18n.t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              resolve({ kind: 'dismissed' });
            },
          },
          {
            text: i18n.t('common.retry'),
            onPress: () => {
              void accept();
            },
          },
        ],
        { cancelable: false }
      );
    }
    const show = () => {
      Alert.alert(
        i18n.t('prReview.discussion.termsTitle'),
        i18n.t('prReview.discussion.termsCopy'),
        [
          {
            text: i18n.t('common.cancel'),
            style: 'cancel',
            onPress: () => {
              resolve({ kind: 'dismissed' });
            },
          },
          {
            text: i18n.t('prReview.discussion.viewTerms'),
            onPress: () => {
              void WebBrowser.openBrowserAsync(`${WEB_BASE_URL}/terms-app`);
              show();
            },
          },
          {
            text: i18n.t('prReview.discussion.acceptTerms'),
            onPress: () => {
              void accept();
            },
          },
        ],
        { cancelable: false }
      );
    };
    show();
  });
  return outcome;
}
