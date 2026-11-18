'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';

const SOUND_NOTIFICATIONS_KEY = 'kilo-sound-notifications-enabled';

export function useSoundNotificationsPreference() {
  return useLocalStorage(SOUND_NOTIFICATIONS_KEY, false, {
    initializeWithValue: false,
    deserializer: value => value === 'true',
  });
}

/**
 * Hook for playing celebration sound when cloud agent streaming completes successfully.
 * Loads audio only on first play and handles browser autoplay restrictions gracefully.
 * Respects user preference stored in localStorage.
 */
export function useCelebrationSound() {
  const [soundEnabled] = useSoundNotificationsPreference();
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
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
    if (!audioRef.current) {
      audioRef.current = new Audio('/sounds/celebration.wav');
      audioRef.current.preload = 'none';
    }
    if (audioRef.current) {
      // Reset to start if already played
      audioRef.current.currentTime = 0;
      // Play (handles autoplay restriction gracefully - silently fails if blocked)
      audioRef.current.play().catch(() => {
        // Autoplay blocked by browser - silently ignore
      });
    }
  }, [soundEnabled]);

  return { play };
}
