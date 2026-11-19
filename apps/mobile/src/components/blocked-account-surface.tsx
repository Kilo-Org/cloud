import { useTranslation } from 'react-i18next';

import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';

/**
 * The blocked-account explanation. Retry re-reads the account while the
 * session that was refused still exists, so a block lifted server-side
 * dismisses the surface without a sign-out; with no session left (the refresh
 * route's refusal) Sign out is the only exit.
 */
export function BlockedAccountSurface({
  canRetry,
  retrying,
  onRetry,
  onSignOut,
}: Readonly<{
  /** False once the refused session is gone: nothing is left to re-read. */
  canRetry: boolean;
  /** A retry read is in flight; the primary button shows its busy state. */
  retrying: boolean;
  onRetry: () => void;
  onSignOut: () => void;
}>) {
  const { t } = useTranslation();
  const copy = {
    title: t('accountBlocked.title'),
    description: t('accountBlocked.description'),
    secondaryLabel: t('common.signOut'),
    secondaryAccessibilityLabel: t('common.signOut'),
    onSecondaryPress: onSignOut,
  };
  if (!canRetry) {
    return <BootstrapErrorScreen {...copy} />;
  }
  return (
    <BootstrapErrorScreen
      {...copy}
      primaryLabel={t('common.retry')}
      primaryAccessibilityLabel={t('bootstrap.retryLoadingAccount')}
      onPrimaryPress={onRetry}
      primaryLoading={retrying}
    />
  );
}
