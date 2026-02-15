import { useState, useRef, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { trpc } from '@/lib/trpc.client';

type UseChatGhostTextProps = {
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  enableChatAutocomplete: boolean;
};

// Generate a unique ID for each request to avoid race conditions
function generateRequestId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// Insert text at cursor position in a textarea
function insertTextAtCursor(textarea: HTMLTextAreaElement, text: string): void {
  const { selectionStart, value } = textarea;
  const newValue = value.slice(0, selectionStart) + text + value.slice(selectionStart);
  textarea.value = newValue;
  // Move cursor to end of inserted text
  const newCursorPos = selectionStart + text.length;
  textarea.setSelectionRange(newCursorPos, newCursorPos);
  // Trigger input event so React sees the change
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

// Extract the next word from ghost text (for ArrowRight partial acceptance)
function extractNextWord(text: string): { word: string; remainder: string } {
  const match = text.match(/^(\s*\S+)/);
  if (!match) {
    return { word: text, remainder: '' };
  }
  const word = match[1];
  const remainder = text.slice(word.length);
  return { word, remainder };
}

let debugEnabled = false;
if (typeof window !== 'undefined') {
  debugEnabled = window.localStorage?.getItem('debug:cloud-agent:autocomplete') === 'true';
}

function debugCloudAgentAutocomplete(label: string, data?: unknown): void {
  if (debugEnabled) {
    console.log(`[useChatGhostText:${label}]`, data);
  }
}

/**
 * Hook that manages ghost text autocomplete for the cloud agent chat input.
 * Provides debounced FIM completion suggestions and keyboard handlers for accepting them.
 */
export function useChatGhostText({ textAreaRef, enableChatAutocomplete }: UseChatGhostTextProps) {
  const [ghostText, setGhostText] = useState('');
  const completionDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const skipNextCompletionRef = useRef(false);
  const completionRequestIdRef = useRef<string>('');
  const trpcClient = trpc.useUtils();

  const requestCompletion = useCallback(
    async ({ prefix, requestId }: { prefix: string; requestId: string }) => {
      console.log('[useChatGhostText] requestCompletion called', {
        prefixLength: prefix.length,
        requestId,
        currentRequestId: completionRequestIdRef.current,
      });
      debugCloudAgentAutocomplete('request', {
        prefixLength: prefix.length,
        requestId,
      });

      // Only process if this is still the latest request
      if (requestId !== completionRequestIdRef.current) {
        console.log('[useChatGhostText] stale request, ignoring', {
          requestId,
          currentRequestId: completionRequestIdRef.current,
        });
        debugCloudAgentAutocomplete('stale', { requestId });
        return;
      }

      try {
        const result = await trpcClient.cloudAgent.getFimAutocomplete.mutate({
          prefix,
          suffix: '',
          requestId,
        });

        console.log('[useChatGhostText] got result', {
          requestId,
          currentRequestId: completionRequestIdRef.current,
          suggestionLength: result.suggestion.length,
          suggestionPreview: result.suggestion.slice(0, 50),
        });
        debugCloudAgentAutocomplete('result', {
          requestId,
          suggestionLength: result.suggestion.length,
        });

        // Only update ghost text if this is still the latest request
        if (requestId === completionRequestIdRef.current) {
          setGhostText(result.suggestion);
        } else {
          console.log('[useChatGhostText] result is stale, not updating ghost text', {
            requestId,
            currentRequestId: completionRequestIdRef.current,
          });
          debugCloudAgentAutocomplete('result-stale', { requestId });
        }
      } catch (error) {
        debugCloudAgentAutocomplete('error', error);
        // Silently ignore errors - just don't show ghost text
        setGhostText('');
      }
    },
    [trpcClient]
  );

  const clearGhostText = useCallback(() => {
    setGhostText('');
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
      const textArea = textAreaRef.current;
      if (!textArea) {
        return false;
      }

      const hasSelection = textArea.selectionStart !== textArea.selectionEnd;
      const isCursorAtEnd = textArea.selectionStart === textArea.value.length;
      const canAcceptCompletion = ghostText && !hasSelection && isCursorAtEnd;

      // Tab: Accept full ghost text
      if (event.key === 'Tab' && !event.shiftKey && canAcceptCompletion) {
        debugCloudAgentAutocomplete('accept', { via: 'Tab', ghostText });
        event.preventDefault();
        skipNextCompletionRef.current = true;
        insertTextAtCursor(textArea, ghostText);
        setGhostText('');
        return true;
      }

      // ArrowRight: Accept next word only
      if (
        event.key === 'ArrowRight' &&
        !event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        canAcceptCompletion
      ) {
        const { word, remainder } = extractNextWord(ghostText);
        debugCloudAgentAutocomplete('accept', {
          via: 'ArrowRight',
          word,
          remainderPreview: remainder.slice(0, 120),
        });
        event.preventDefault();
        skipNextCompletionRef.current = true;
        insertTextAtCursor(textArea, word);
        setGhostText(remainder);
        return true;
      }

      // Escape: Clear ghost text
      if (event.key === 'Escape' && ghostText) {
        debugCloudAgentAutocomplete('clear', { via: 'Escape' });
        setGhostText('');
      }
      return false;
    },
    [ghostText, textAreaRef]
  );

  const handleInputChange = useCallback(
    (newValue: string) => {
      console.log('[useChatGhostText] handleInputChange called', {
        enableChatAutocomplete,
        newValueLength: newValue.length,
      });
      debugCloudAgentAutocomplete('input-change', {
        enableChatAutocomplete,
        newValueLength: newValue.length,
        startsWithSlash: newValue.startsWith('/'),
        includesAt: newValue.includes('@'),
        skipNext: skipNextCompletionRef.current,
      });

      // Clear any existing ghost text when typing
      setGhostText('');

      // Clear any pending completion request
      if (completionDebounceRef.current) {
        clearTimeout(completionDebounceRef.current);
      }

      // Skip completion request if we just accepted a suggestion (Tab) or undid
      if (skipNextCompletionRef.current) {
        console.log('[useChatGhostText] skipping - skipNextCompletionRef is true');
        skipNextCompletionRef.current = false;
        // Don't request a new completion - wait for user to type more
      } else if (
        enableChatAutocomplete &&
        newValue.length >= 5 &&
        !newValue.startsWith('/') &&
        !newValue.includes('@')
      ) {
        // Request new completion after debounce (only if feature is enabled)
        const requestId = generateRequestId();
        completionRequestIdRef.current = requestId;

        console.log('[useChatGhostText] scheduling completion request', {
          requestId,
          debounceMs: 300,
          textLength: newValue.length,
        });
        debugCloudAgentAutocomplete('schedule', {
          requestId,
          debounceMs: 300,
        });

        completionDebounceRef.current = setTimeout(() => {
          console.log('[useChatGhostText] debounce fired, calling requestCompletion', {
            requestId,
          });
          void requestCompletion({
            prefix: newValue,
            requestId,
          });
        }, 300); // 300ms debounce
      } else {
        console.log('[useChatGhostText] not scheduling', {
          enableChatAutocomplete,
          length: newValue.length,
          startsWithSlash: newValue.startsWith('/'),
          includesAt: newValue.includes('@'),
        });
        debugCloudAgentAutocomplete('no-schedule', {
          reason: enableChatAutocomplete ? 'guards-not-met' : 'disabled',
        });
      }
    },
    [enableChatAutocomplete, requestCompletion]
  );

  useEffect(() => {
    return () => {
      if (completionDebounceRef.current) {
        clearTimeout(completionDebounceRef.current);
      }
    };
  }, []);

  return {
    ghostText,
    handleKeyDown,
    handleInputChange,
    clearGhostText,
  };
}
