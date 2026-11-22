import { useTranslation } from 'react-i18next';

import { type AccountBlockedRefusalReason } from '@kilocode/app-shared/auth';

import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';

/**
 * The blocked-account explanation, shaped by the refusal reason the server
 * published.
 *
 * Contact support is the filled action in every state: it is the only step
 * that can change a block, and the copy says a fresh sign-in cannot. For an
 * account block, Retry is the outlined secondary below it — it re-reads the
 * account over the session that was refused (it does not sign in), so a block
 * lifted server-side dismisses the surface without a sign-out. With no session
 * left (the refresh route's refusal) nothing is left to re-read, so Retry is
 * gone and the exit moves up: it only reveals the screen the app has already
 * settled on — the login screen — so it is labelled for that reveal instead of
 * for a sign-out that already happened.
 */
export function BlockedAccountSurface({
  reason,
  canRetry,
  retrying,
  onRetry,
  onContactSupport,
  onSignOut,
}: Readonly<{
  /** Which refusal the server answered with; it picks the actions offered. */
  reason: AccountBlockedRefusalReason;
  /** False once the refused session is gone: nothing is left to re-read. */
  canRetry: boolean;
  /** A retry read is in flight; the outlined retry shows its busy state. */
  retrying: boolean;
  onRetry: () => void;
  onContactSupport: () => void;
  onSignOut: () => void;
}>) {
  const { t } = useTranslation();
  // Without a session the exit cannot sign out: it clears the explanation and
  // reveals the login screen, so it says what it does.
  const exitLabel = canRetry ? t('common.signOut') : t('common.continue');
  const description =
    reason === 'email_domain_blocked'
      ? t('accountBlocked.domainDescription')
      : t('accountBlocked.description');
  // A domain refusal is a property of the email domain, not of this account's
  // state, so a re-read returns the same answer: it gets no retry row, and the
  // exit takes the secondary slot straight under the support action.
  if (!canRetry || reason === 'email_domain_blocked') {
    return (
      <BootstrapErrorScreen
        title={t('accountBlocked.title')}
        description={description}
        primaryLabel={t('accountBlocked.contactSupport')}
        primaryAccessibilityLabel={t('accountBlocked.contactSupport')}
        onPrimaryPress={onContactSupport}
        secondaryLabel={exitLabel}
        secondaryAccessibilityLabel={exitLabel}
        onSecondaryPress={onSignOut}
      />
    );
  }
  return (
    <BootstrapErrorScreen
      title={t('accountBlocked.title')}
      description={description}
      primaryLabel={t('accountBlocked.contactSupport')}
      primaryAccessibilityLabel={t('accountBlocked.contactSupport')}
      onPrimaryPress={onContactSupport}
      secondaryLabel={t('common.retry')}
      secondaryAccessibilityLabel={t('bootstrap.retryLoadingAccount')}
      onSecondaryPress={onRetry}
      secondaryLoading={retrying}
      tertiaryLabel={exitLabel}
      tertiaryAccessibilityLabel={exitLabel}
      onTertiaryPress={onSignOut}
    />
  );
}
