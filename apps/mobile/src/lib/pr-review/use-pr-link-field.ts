import { useCallback, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import { prLinkDraft } from '@/lib/pr-review/pr-link-draft';
import { consumePrLinkInputEcho, pushPrLinkInputEcho } from '@/lib/pr-review/pr-link-input-echo';
import {
  decidePrLinkOpen,
  type PrLinkOpenState,
  selectPrLinkOpenState,
} from '@/lib/pr-review/pr-link-paste';

/**
 * The PR-link field's uncontrolled state.
 *
 * The field is uncontrolled — the raw text lives in a ref so the submit
 * handler reads the latest value without a re-render per keystroke — and the
 * module draft (`prLinkDraft`) mirrors every write, so an open that a review
 * push or a Back unmounts comes back with the link still in the field.
 */
export function usePrLinkField() {
  // The TextInput component ref is for focus() and setNativeProps on
  // programmatic paste.
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef<string>(prLinkDraft.text);
  // Values written via setNativeProps, so a late matching onChangeText is
  // treated as a programmatic echo instead of clobbering the ref.
  // Order-agnostic membership so double-taps and delayed native echoes work.
  const pendingProgrammaticTextsRef = useRef<string[]>([]);
  const [hasInput, setHasInput] = useState(prLinkDraft.text.length > 0);
  const [linkState, setLinkState] = useState<PrLinkOpenState>(
    selectPrLinkOpenState(prLinkDraft.text)
  );

  const updateInputState = useCallback((text: string) => {
    setHasInput(text.length > 0);
    setLinkState(selectPrLinkOpenState(text));
  }, []);

  /** Replace the field: native text, ref, draft and derived UI together. */
  const writeField = useCallback(
    (text: string) => {
      pendingProgrammaticTextsRef.current = pushPrLinkInputEcho(
        pendingProgrammaticTextsRef.current,
        text
      );
      textRef.current = text;
      prLinkDraft.text = text;
      inputRef.current?.setNativeProps({ text });
      updateInputState(text);
    },
    [updateInputState]
  );

  /** The field's own onChangeText: ref and draft, skipping programmatic echoes. */
  const handleFieldChange = useCallback(
    (value: string) => {
      const decision = consumePrLinkInputEcho(pendingProgrammaticTextsRef.current, value);
      pendingProgrammaticTextsRef.current = [...decision.pending];
      if (decision.kind === 'echo') {
        // Echo of setNativeProps: textRef already holds the intentional
        // value from writeField — do not clobber it with a delayed/stale echo.
        return;
      }
      textRef.current = value;
      prLinkDraft.text = value;
      updateInputState(value);
    },
    [updateInputState]
  );

  /**
   * Empty the field after real typing. clear() is the iOS-safe native empty:
   * setNativeProps({ text: '' }) loses the most-recent-event-count race and
   * leaves the typed text visible while React state thinks the field is
   * empty. No echo is pushed for '' — a non-arriving echo would stale the FIFO.
   */
  const clearField = useCallback(() => {
    textRef.current = '';
    prLinkDraft.text = '';
    updateInputState('');
    inputRef.current?.clear();
    inputRef.current?.focus();
  }, [updateInputState]);

  /** Put the stored draft back in the native field on a remount or refocus. */
  const restoreDraft = useCallback(() => {
    if (prLinkDraft.text.length > 0) {
      writeField(prLinkDraft.text);
    }
  }, [writeField]);

  const submitDecision = useCallback(() => decidePrLinkOpen(textRef.current), []);

  return {
    inputRef,
    /** Text the uncontrolled field mounts with (the restored draft). */
    initialText: prLinkDraft.text,
    hasInput,
    linkState,
    writeField,
    handleFieldChange,
    clearField,
    restoreDraft,
    submitDecision,
  };
}
