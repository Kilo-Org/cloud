import { useTranslation } from 'react-i18next';

import { QueryError } from '@/components/query-error';
import { classifySshStorageFailure } from '@/lib/ssh/store';

type SshStorageErrorProps = Readonly<{
  error: unknown;
  onRetry?: () => void;
  isRetrying?: boolean;
}>;

/**
 * The on-device store did not open.
 *
 * A locked device is the one failure trying again recovers, so that state
 * carries the Retry. Every other open failure needs the app relaunched, and a
 * Retry button there would be pressed and do nothing.
 */
export function SshStorageError({ error, onRetry, isRetrying = false }: SshStorageErrorProps) {
  const { t } = useTranslation();

  if (classifySshStorageFailure(error) === 'locked') {
    return (
      <QueryError
        variant="permission"
        title={t('ssh.storage.lockedTitle')}
        message={t('ssh.storage.lockedMessage')}
        onRetry={onRetry}
        isRetrying={isRetrying}
      />
    );
  }

  return (
    <QueryError
      variant="server"
      title={t('ssh.storage.unavailableTitle')}
      message={t('ssh.storage.unavailableMessage')}
    />
  );
}
