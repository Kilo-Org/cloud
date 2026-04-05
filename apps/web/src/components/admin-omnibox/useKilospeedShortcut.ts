'use client';

import { useEffect, useRef, useCallback } from 'react';

/**
 * Hook to detect "kilospeed" or "ks" keyboard sequences
 *
 * The shortcut is ignored when focus is in an input, textarea, or contenteditable element.
 * The sequence must be typed within a reasonable time window (2 seconds between keystrokes).
 */
export function useKilospeedShortcut(onActivate: () => void) {
  const bufferRef = useRef('');
  const lastKeyTimeRef = useRef(0);
  const pendingActivationRef = useRef(false);

  const TIMEOUT_MS = 2000; // Reset buffer if no key pressed for 2 seconds
  const TRIGGER_SEQUENCES = ['kilospeed', 'ks'];

  const resetBuffer = useCallback(() => {
    bufferRef.current = '';
  }, []);

  const checkTrigger = useCallback(
    (event: KeyboardEvent) => {
      const buffer = bufferRef.current.toLowerCase();

      for (const sequence of TRIGGER_SEQUENCES) {
        if (buffer.endsWith(sequence)) {
          // Prevent the triggering key from being typed into the input
          event.preventDefault();
          event.stopPropagation();

          resetBuffer();

          // Use a microtask to ensure the event is fully processed before opening
          pendingActivationRef.current = true;
          queueMicrotask(() => {
            if (pendingActivationRef.current) {
              pendingActivationRef.current = false;
              onActivate();
            }
          });

          return true;
        }
      }
      return false;
    },
    [onActivate, resetBuffer]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ignore if focus is in an input element
      const target = event.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();
      const isEditable =
        tagName === 'input' ||
        tagName === 'textarea' ||
        target.isContentEditable ||
        target.getAttribute('contenteditable') === 'true';

      if (isEditable) {
        return;
      }

      // Ignore modifier keys and special keys
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // Only process single character keys
      if (event.key.length !== 1) {
        return;
      }

      const now = Date.now();

      // Reset buffer if too much time has passed
      if (now - lastKeyTimeRef.current > TIMEOUT_MS) {
        resetBuffer();
      }

      lastKeyTimeRef.current = now;

      // Add key to buffer
      bufferRef.current += event.key;

      // Keep buffer at reasonable length (longest trigger + some margin)
      const maxLength = Math.max(...TRIGGER_SEQUENCES.map(s => s.length)) + 5;
      if (bufferRef.current.length > maxLength) {
        bufferRef.current = bufferRef.current.slice(-maxLength);
      }

      // Check if we've triggered (this may prevent the event)
      checkTrigger(event);
    };

    // Use capture phase to intercept the event before it reaches other handlers
    window.addEventListener('keydown', handleKeyDown, { capture: true });

    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, [checkTrigger, resetBuffer]);

  return { resetBuffer };
}
