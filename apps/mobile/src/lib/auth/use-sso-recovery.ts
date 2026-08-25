import { useCallback, useState } from 'react';

export type SsoRecovery = { email: string; ssoOrganizationId: string | undefined };

export function useSsoRecovery() {
  const [ssoRecovery, setSsoRecovery] = useState<SsoRecovery | null>(null);

  const clearSsoRecovery = useCallback(() => {
    setSsoRecovery(null);
  }, []);

  const handleSsoError = useCallback((email: string, ssoOrganizationId: string | undefined) => {
    setSsoRecovery({ email, ssoOrganizationId });
  }, []);

  return { ssoRecovery, clearSsoRecovery, handleSsoError };
}
