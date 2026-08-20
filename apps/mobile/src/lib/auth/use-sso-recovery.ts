import * as Sentry from '@sentry/react-native';
import { useCallback, useState } from 'react';

export type SsoRecovery = { email: string; ssoOrganizationId: string | undefined };

export function useSsoRecovery() {
  const [ssoRecovery, setSsoRecovery] = useState<SsoRecovery | null>(null);

  const clearSsoRecovery = useCallback(() => {
    setSsoRecovery(null);
  }, []);

  // The organization id is reported to Sentry as a breadcrumb tag only. It is
  // deliberately NOT put in any URL — the web SSO page resolves the organization
  // from the email itself.
  const handleSsoError = useCallback((email: string, ssoOrganizationId: string | undefined) => {
    setSsoRecovery({ email, ssoOrganizationId });
    if (!ssoOrganizationId) {
      return;
    }
    Sentry.addBreadcrumb({
      category: 'auth',
      level: 'info',
      message: 'SSO recovery',
      data: { ssoOrganizationId },
    });
  }, []);

  return { ssoRecovery, clearSsoRecovery, handleSsoError };
}
