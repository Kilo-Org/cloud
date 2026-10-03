import { useLayoutEffect, useRef } from 'react';

export type ComposerFocusRequest = { sessionId: string; onHandled: () => void };

export function useSessionComposerFocus(
  request: ComposerFocusRequest | null | undefined,
  sessionId: string | null,
  ready: boolean,
  blocked: boolean,
  disabled: boolean
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingRef = useRef<ComposerFocusRequest | null>(null);
  const handledRef = useRef<ComposerFocusRequest | null>(null);

  useLayoutEffect(() => {
    if (!request || handledRef.current === request) return;
    pendingRef.current = null;
    if (!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
      handledRef.current = request;
      request.onHandled();
      return;
    }
    pendingRef.current = request;
    const cancel = () => {
      if (pendingRef.current !== request) return;
      pendingRef.current = null;
      handledRef.current = request;
      request.onHandled();
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('focusin', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('focusin', cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, [request]);

  useLayoutEffect(() => {
    if (!request) pendingRef.current = null;
    if (!pendingRef.current || pendingRef.current.sessionId !== sessionId || !ready) return;
    if (blocked) {
      handledRef.current = pendingRef.current;
      pendingRef.current.onHandled();
      pendingRef.current = null;
      return;
    }
    const textarea = textareaRef.current;
    if (disabled || !textarea || textarea.disabled || textarea.readOnly) return;
    handledRef.current = pendingRef.current;
    pendingRef.current.onHandled();
    pendingRef.current = null;
    if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) {
      textarea.focus({ preventScroll: true });
    }
  }, [request, sessionId, ready, blocked, disabled]);

  return textareaRef;
}
