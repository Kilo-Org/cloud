'use client';

/**
 * useAutoScroll Hook
 *
 * Manages auto-scroll behavior for chat messages container.
 * Tracks whether user has scrolled up and provides a "scroll to bottom" button.
 *
 * Features:
 * - Auto-scrolls to bottom when new messages arrive (if user is near bottom)
 * - Shows scroll button when user scrolls up
 * - Provides manual scroll-to-bottom function
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { chatUIAtom } from '../store/atoms';

type UseAutoScrollReturn = {
  /** Ref to attach to the invisible anchor element at the bottom of messages */
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
  /** Ref to attach to the scroll container */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** Whether to show the "scroll to bottom" button */
  showScrollButton: boolean;
  /** Handler to attach to the scroll container's onScroll event */
  handleScroll: () => void;
  /** Function to programmatically scroll to the bottom */
  scrollToBottom: () => void;
};

/**
 * Hook for managing auto-scroll behavior in the chat message container.
 *
 * @param dynamicMessages - The dynamic messages array (triggers auto-scroll effect)
 * @returns Refs, state, and handlers for auto-scroll behavior
 */
export function useAutoScroll(dynamicMessages: unknown[]): UseAutoScrollReturn {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [chatUI, setChatUI] = useAtom(chatUIAtom);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Auto-scroll effect - only scroll when dynamic messages change AND user is near bottom
  // Note: staticMessages intentionally excluded - they never change once rendered
  useEffect(() => {
    if (chatUI.shouldAutoScroll && messagesEndRef.current) {
      // Use scrollTo instead of scrollIntoView to avoid horizontal scroll issues
      const container = scrollContainerRef.current;
      if (container) {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: 'smooth',
        });
      }
    }
  }, [dynamicMessages, chatUI.shouldAutoScroll]);

  // Handle scroll events to detect if user scrolled up
  const handleScroll = useCallback(() => {
    if (!scrollContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } = scrollContainerRef.current;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 100; // Within 100px of bottom

    setShowScrollButton(!isNearBottom);
    setChatUI({ shouldAutoScroll: isNearBottom });
  }, [setChatUI]);

  // Scroll to bottom when clicking the button
  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: 'smooth',
      });
      setChatUI({ shouldAutoScroll: true });
      setShowScrollButton(false);
    }
  }, [setChatUI]);

  return {
    messagesEndRef,
    scrollContainerRef,
    showScrollButton,
    handleScroll,
    scrollToBottom,
  };
}
