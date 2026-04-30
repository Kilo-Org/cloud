import { useEffect, useState } from 'react';

import { useKiloChatTokenGetter } from './use-kilo-chat-token';

/**
 * Decodes the `kiloUserId` claim from the kilo-chat JWT and returns it as the
 * current user's ID. Returns `null` while loading or if the token cannot be
 * decoded. The token is minted by `generateApiToken`, which writes the user id
 * as `kiloUserId` (not the standard JWT `sub` claim).
 */
export function useCurrentUserId(): string | null {
  const getToken = useKiloChatTokenGetter();
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchUserId() {
      try {
        const token = await getToken();
        if (cancelled) {
          return;
        }
        const parts = token.split('.');
        if (parts.length < 2 || !parts[1]) {
          return;
        }
        const payload = parts[1];
        const decoded = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
        const parsed = JSON.parse(decoded) as Record<string, unknown>;
        const kiloUserId = typeof parsed.kiloUserId === 'string' ? parsed.kiloUserId : null;
        setUserId(kiloUserId);
      } catch {
        // Leave userId as null on failure
      }
    }

    void fetchUserId();

    return () => {
      cancelled = true;
    };
  }, [getToken]);

  return userId;
}
