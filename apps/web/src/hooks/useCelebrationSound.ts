'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

/**
 * localStorage key for sound notifications preference.
 * Exported so other components can read/write this preference.
 */
export const SOUND_NOTIFICATIONS_KEY = 'kilo-sound-notifications-enabled';

/**
 * Hook for playing celebration sound when cloud agent streaming completes successfully.
 * Preloads audio on mount and handles browser autoplay restrictions gracefully.
 * Respects user preference stored in localStorage.
 */
export function useCelebrationSound() {
  const [soundEnabled, setSoundEnabled] = useLocalStorage(SOUND_NOTIFICATIONS_KEY, true, {
    initializeWithValue: false,
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Preload audio on mount
    audioRef.current = new Audio('/sounds/celebration.wav');
    audioRef.current.preload = 'auto';
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
        audioRef.current = null;
      }
    };
  }, []);

  const play = useCallback(() => {
    // Check if sound is enabled before playing
    if (!soundEnabled) return;

    if (audioRef.current) {
      // Reset to start if already played
      audioRef.current.currentTime = 0;
      // Play (handles autoplay restriction gracefully - silently fails if blocked)
      audioRef.current.play().catch(() => {
        // Autoplay blocked by browser - silently ignore
      });
    }
  }, [soundEnabled]);

  return { play, soundEnabled, setSoundEnabled };
}
