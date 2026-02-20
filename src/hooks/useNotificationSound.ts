'use client';

import { useCallback, useRef } from 'react';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { SOUND_NOTIFICATIONS_KEY } from '@/hooks/useCelebrationSound';

/**
 * Play a single tone with exponential decay.
 */
function playTone(
  audioCtx: AudioContext,
  frequency: number,
  startTime: number,
  duration: number,
  volume: number
) {
  const oscillator = audioCtx.createOscillator();
  const gain = audioCtx.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startTime);

  gain.gain.setValueAtTime(volume, startTime);
  gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

  oscillator.connect(gain);
  gain.connect(audioCtx.destination);

  oscillator.start(startTime);
  oscillator.stop(startTime + duration);
}

/**
 * Two-tone "ding-ding" chime — audible but not jarring.
 */
function playChime(audioCtx: AudioContext) {
  const now = audioCtx.currentTime;
  playTone(audioCtx, 660, now, 0.4, 0.35);
  playTone(audioCtx, 880, now + 0.18, 0.4, 0.35);
}

/**
 * Hook for playing a notification chime when the agent asks a question.
 * Uses Web Audio API synthesis (no binary asset needed).
 * Respects the same sound-notifications localStorage toggle as useCelebrationSound.
 */
export function useNotificationSound() {
  const [soundEnabled] = useLocalStorage(SOUND_NOTIFICATIONS_KEY, true);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playNotification = useCallback(() => {
    if (!soundEnabled) return;

    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      // Resume context if suspended (browser autoplay policy)
      if (audioCtxRef.current.state === 'suspended') {
        void audioCtxRef.current.resume();
      }
      playChime(audioCtxRef.current);
    } catch {
      // Web Audio API unavailable or blocked — silently ignore
    }
  }, [soundEnabled]);

  return { playNotification };
}
