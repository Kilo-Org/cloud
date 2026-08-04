import { useEffect, useRef } from 'react';
import { AppState, type TextInput } from 'react-native';

import { resolveMessageInputAppStateTransition } from '@/lib/message-input-app-state';

const MESSAGE_INPUT_FOCUS_RESTORE_DELAY_MS = 100;

type UseMessageInputAppStateFocusInputs = {
  inputRef: React.RefObject<TextInput | null>;
  inputFocusedRef: React.RefObject<boolean>;
  disabled?: boolean;
  submitDisabled?: boolean;
};

export function useMessageInputAppStateFocus({
  inputRef,
  inputFocusedRef,
  disabled,
  submitDisabled,
}: UseMessageInputAppStateFocusInputs) {
  const restoreFocusOnActiveRef = useRef(false);
  const restoreFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearRestoreFocusTimeout = () => {
      if (restoreFocusTimeoutRef.current !== null) {
        clearTimeout(restoreFocusTimeoutRef.current);
        restoreFocusTimeoutRef.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', nextAppState => {
      const transition = resolveMessageInputAppStateTransition({
        nextAppState,
        restoreFocusOnActive: restoreFocusOnActiveRef.current,
        wasFocused: inputFocusedRef.current,
      });
      restoreFocusOnActiveRef.current = transition.restoreFocusOnActive;

      if (transition.shouldBlur) {
        clearRestoreFocusTimeout();
        inputRef.current?.blur();
      }

      if (transition.shouldFocus && disabled !== true && submitDisabled !== true) {
        clearRestoreFocusTimeout();
        restoreFocusTimeoutRef.current = setTimeout(() => {
          restoreFocusTimeoutRef.current = null;
          inputRef.current?.focus();
        }, MESSAGE_INPUT_FOCUS_RESTORE_DELAY_MS);
      }
    });

    return () => {
      subscription.remove();
      clearRestoreFocusTimeout();
    };
  }, [disabled, submitDisabled, inputRef, inputFocusedRef]);
}
