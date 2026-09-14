import { useCallback, useEffect, useState } from 'react';

import {
  getVoiceRecognitionLocales,
  invalidateVoiceRecognitionLocalesCache,
} from './voice-input-language';

export type VoiceRecognitionLanguages = {
  /** Locale tags the device's speech recognition reports as supported. */
  languages: string[];
  isLoading: boolean;
  /** The service call failed. Distinct from "the service reported no languages". */
  isError: boolean;
  /** Drop the session cache and query the service again. */
  refetch: () => void;
};

/**
 * The recognition service's supported locale list for the voice-language
 * picker. `getVoiceRecognitionLocales` memoizes the fetch for the session, so
 * reopening the sheet reuses it. A `null` result (the service call failed) is
 * the retryable error state; an empty list is a successful answer the service
 * gave, which no retry can change. `refetch` invalidates the cache first so a
 * retry actually re-queries instead of replaying the memoized failure.
 */
export function useVoiceRecognitionLanguages(): VoiceRecognitionLanguages {
  const [languages, setLanguages] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isError, setIsError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setIsError(false);

    const load = async () => {
      try {
        const result = await getVoiceRecognitionLocales();
        if (cancelled) {
          return;
        }
        if (result === null) {
          setIsError(true);
          setLanguages([]);
          return;
        }
        setLanguages([...result.locales]);
      } catch {
        if (!cancelled) {
          setIsError(true);
          setLanguages([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void load();

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const refetch = useCallback(() => {
    invalidateVoiceRecognitionLocalesCache();
    setReloadToken(token => token + 1);
  }, []);

  return { languages, isLoading, isError, refetch };
}
