import { useCallback, useEffect, useState } from 'react';

import { useKiloChatToken } from './use-kilo-chat-token';

/**
 * Decodes the kilo-chat JWT to extract the current user's ID (kiloUserId).
 * This is safe to do client-side — we are reading a claim, not verifying the
 * signature. Returns an empty string while the token is being fetched.
 */
function extractKiloUserId(token: string): string {
  try {
    const payload = token.split('.')[1];
    if (!payload) {
      return '';
    }
    const decoded = JSON.parse(atob(payload.replaceAll('-', '+').replaceAll('_', '/'))) as Record<
      string,
      unknown
    >;
    return typeof decoded.kiloUserId === 'string' ? decoded.kiloUserId : '';
  } catch {
    return '';
  }
}

export function useCurrentUserId(): string {
  const { getToken } = useKiloChatToken();
  const [userId, setUserId] = useState('');

  const fetchUserId = useCallback(async () => {
    try {
      const token = await getToken();
      setUserId(extractKiloUserId(token));
    } catch {
      // leave as empty string — hooks that need userId will simply not optimistically
      // attribute ownership to the current user (reactions, bubble alignment)
    }
  }, [getToken]);

  useEffect(() => {
    void fetchUserId();
  }, [fetchUserId]);

  return userId;
}
