import { useTranslation } from 'react-i18next';

import { BootstrapErrorScreen } from '@/components/bootstrap-error-screen';

export function LanguageReloadErrorScreen({
  onRetry,
  onContinue,
}: Readonly<{
  onRetry: () => void;
  onContinue: () => void;
}>) {
  const { t } = useTranslation();
  return (
    <BootstrapErrorScreen
      title={t('language.couldNotRestart')}
      description={t('language.languageSaved')}
      primaryLabel={t('common.retry')}
      primaryAccessibilityLabel={t('language.retry')}
      onPrimaryPress={onRetry}
      secondaryLabel={t('common.continue')}
      secondaryAccessibilityLabel={t('common.continue')}
      onSecondaryPress={onContinue}
    />
  );
}
