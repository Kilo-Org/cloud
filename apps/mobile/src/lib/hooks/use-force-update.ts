import * as Application from 'expo-application';
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';

import { API_BASE_URL } from '@/lib/config';

type MinVersionResponse = {
  ios: string;
  android: string;
};

function isVersionBelow(current: string, minimum: string): boolean {
  const currentParts = current.split('.').map(Number);
  const minimumParts = minimum.split('.').map(Number);

  for (let i = 0; i < 3; i += 1) {
    const cur = currentParts[i] ?? 0;
    const min = minimumParts[i] ?? 0;
    if (cur < min) {
      return true;
    }
    if (cur > min) {
      return false;
    }
  }
  return false;
}

export function useForceUpdate() {
  const [state, setState] = useState({
    updateRequired: false,
    isChecking: true,
  });

  useEffect(() => {
    const controller = new AbortController();

    async function check() {
      try {
        const response = await fetch(`${API_BASE_URL}/api/app/min-version`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        if (!response.ok) {
          setState({ updateRequired: false, isChecking: false });
          return;
        }

        const data = (await response.json()) as MinVersionResponse;
        const nativeVersion = Application.nativeApplicationVersion;

        if (!nativeVersion) {
          setState({ updateRequired: false, isChecking: false });
          return;
        }

        const minVersion = Platform.OS === 'ios' ? data.ios : data.android;
        const updateRequired = isVersionBelow(nativeVersion, minVersion);

        setState({ updateRequired, isChecking: false });
      } catch {
        // Fail open — network errors should not block the user
        setState({ updateRequired: false, isChecking: false });
      }
    }

    void check();

    // 5 second timeout — fail open
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  return state;
}
