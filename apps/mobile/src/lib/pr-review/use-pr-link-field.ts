import { useCallback, useRef, useState } from 'react';
import { type TextInput } from 'react-native';

import { prLinkDraft } from '@/lib/pr-review/pr-link-draft';
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
      /* The ref first: a synchronous echo of setNativeProps then hits the
         no-op in `handleFieldChange` instead of moving the ref to it. */
      textRef.current = text;
      prLinkDraft.text = text;
      inputRef.current?.setNativeProps({ text });
      updateInputState(text);
    },
    [updateInputState]
  );

  /** The field's own onChangeText. The ref follows what the field displays, so Open always acts on the shown link. */
  const handleFieldChange = useCallback(
    (value: string) => {
      if (value === textRef.current) {
        /* `writeField` already holds this value: this is its setNativeProps
           echo, or a person retyping the text that is already shown. Both need
           no write. */
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
   * empty.
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
