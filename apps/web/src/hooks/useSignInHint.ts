import { useState, useEffect, useCallback } from 'react';
import { safeLocalStorage } from '@/lib/localStorage';
import { emailSchema } from '@/lib/schemas/email';
import { type AuthMethod, AllAuthMethodIds } from '@/lib/auth/provider-metadata';

const LOCAL_STORAGE_KEY = 'signin_hint';
const VALID_AUTH_METHODS = AllAuthMethodIds;

export interface SignInHint {
  lastEmail?: string; // Optional - may not be known if user clicked OAuth directly
  lastAuthMethod: AuthMethod;
  orgId?: string; // For SSO users - WorkOS organization ID
  lastLogin: string; // ISO timestamp
}

/**
 * Hook to manage sign-in hint storage in localStorage.
 * Stores the user's last email, auth method, and optional org ID for faster returning user experience.
 */
export function useSignInHint(): {
  hint: SignInHint | null;
  isLoaded: boolean;
  saveHint: (hint: Partial<SignInHint>) => void;
  clearHint: () => void;
} {
  const [hint, setHint] = useState<SignInHint | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const storedHint = safeLocalStorage.getItem(LOCAL_STORAGE_KEY);
    if (storedHint) {
      try {
        const parsed = JSON.parse(storedHint) as SignInHint;

        // Validate the stored hint
        // Email is optional (partial hint), but if present must be valid
        const emailValid =
          !parsed.lastEmail || emailSchema.safeParse({ email: parsed.lastEmail }).success;
        const hasAuthMethod =
          parsed.lastAuthMethod && VALID_AUTH_METHODS.includes(parsed.lastAuthMethod);

        if (emailValid && hasAuthMethod && parsed.lastLogin) {
          setHint(parsed);
        } else {
          // Invalid hint, remove it
          safeLocalStorage.removeItem(LOCAL_STORAGE_KEY);
        }
      } catch {
        // Invalid JSON, remove it
        safeLocalStorage.removeItem(LOCAL_STORAGE_KEY);
      }
    }
    setIsLoaded(true);
  }, []);

  const saveHint = useCallback((partialHint: Partial<SignInHint>) => {
    // Validate email if provided
    if (partialHint.lastEmail) {
      const emailValid = emailSchema.safeParse({ email: partialHint.lastEmail }).success;
      if (!emailValid) {
        console.warn('[useSignInHint] Attempted to save invalid email, skipping');
        return;
      }
    }

    // Get existing hint from localStorage to merge with
    const storedHint = safeLocalStorage.getItem(LOCAL_STORAGE_KEY);
    let existingHint: Partial<SignInHint> = {};

    if (storedHint) {
      try {
        existingHint = JSON.parse(storedHint);
      } catch {
        // Invalid JSON, start fresh
      }
    }

    // Merge with existing hint and ensure required fields have defaults
    const mergedHint: SignInHint = {
      lastAuthMethod: partialHint.lastAuthMethod || existingHint.lastAuthMethod || 'google',
      ...existingHint, // preserve existing fields
      ...partialHint, // override with new values
      lastLogin: new Date().toISOString(), // always update timestamp
    };

    setHint(mergedHint);
    try {
      safeLocalStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(mergedHint));
    } catch (error) {
      console.warn('[useSignInHint] Failed to save hint to localStorage', error);
    }
  }, []);

  const clearHint = useCallback(() => {
    setHint(null);
    safeLocalStorage.removeItem(LOCAL_STORAGE_KEY);
  }, []);

  return { hint, isLoaded, saveHint, clearHint };
}
