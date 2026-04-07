import {
  useState,
  useRef,
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { useRawTRPCClient } from '@/lib/trpc/utils';

type UseChatGhostTextProps = {
  textAreaRef: React.RefObject<HTMLTextAreaElement | null>;
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
  const trpcClient = useRawTRPCClient();

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
        debugCloudAgentAutocomplete('accept', { via: 'ArrowRight', ghostText });
        event.preventDefault();
        skipNextCompletionRef.current = true;
        const { word, remainder } = extractNextWord(ghostText);
        insertTextAtCursor(textArea, word);
        setGhostText(remainder);
        return true;
      }

      // Escape: Clear ghost text
      if (event.key === 'Escape' && ghostText) {
        debugCloudAgentAutocomplete('dismiss', { via: 'Escape' });
        event.preventDefault();
        clearGhostText();
        // Generate new request ID to cancel any pending requests
        completionRequestIdRef.current = generateRequestId();
        return true;
      }

      return false;
    },
    [ghostText, textAreaRef, clearGhostText]
  );

  const handleInputChange = useCallback(
    (newValue: string) => {
      if (!enableChatAutocomplete) {
        setGhostText('');
        return;
      }

      if (skipNextCompletionRef.current) {
        skipNextCompletionRef.current = false;
        setGhostText('');
        return;
      }

      // Clear ghost text immediately when input changes
      setGhostText('');

      // Cancel any pending debounced request
      if (completionDebounceRef.current) {
        clearTimeout(completionDebounceRef.current);
      }

      // Don't request completion for empty/short input
      if (newValue.trim().length < 5) {
        completionRequestIdRef.current = '';
        return;
      }

      // Debounce the completion request
      const requestId = generateRequestId();
      completionRequestIdRef.current = requestId;

      completionDebounceRef.current = setTimeout(() => {
        void requestCompletion({ prefix: newValue, requestId });
      }, 400);
    },
    [enableChatAutocomplete, requestCompletion]
  );

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (completionDebounceRef.current) {
        clearTimeout(completionDebounceRef.current);
      }
    };
  }, []);

  // Clear ghost text when autocomplete is disabled
  useEffect(() => {
    if (!enableChatAutocomplete) {
      setGhostText('');
      completionRequestIdRef.current = '';
    }
  }, [enableChatAutocomplete]);

  return {
    ghostText,
    handleKeyDown,
    handleInputChange,
    clearGhostText,
  };
}
