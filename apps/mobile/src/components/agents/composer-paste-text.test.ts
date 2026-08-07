import { describe, expect, it, vi } from 'vitest';

import { type ComposerSelection, pasteTextIntoComposer } from './composer-paste-text';

/** A composer whose input records what the paste wrote to it. */
function makeTarget(draft: string, selection: ComposerSelection | null, maxLength = 100) {
  const setNativeProps = vi.fn<(props: { text: string; selection: ComposerSelection }) => void>();
  const onChangeText = vi.fn<(text: string) => void>();
  return {
    setNativeProps,
    onChangeText,
    target: { input: { setNativeProps }, draft, selection, maxLength, onChangeText },
  };
}

describe('pasteTextIntoComposer', () => {
  it('inserts at the caret and leaves the caret after the text', () => {
    const { setNativeProps, onChangeText, target } = makeTarget('fix the bug', {
      start: 4,
      end: 4,
    });

    const caret = pasteTextIntoComposer('really ', target);

    expect(setNativeProps).toHaveBeenCalledWith({
      text: 'fix really the bug',
      selection: { start: 11, end: 11 },
    });
    expect(onChangeText).toHaveBeenCalledWith('fix really the bug');
    expect(caret).toEqual({ start: 11, end: 11 });
  });

  it('replaces the selected range', () => {
    const { onChangeText, target } = makeTarget('fix the bug', { start: 4, end: 7 });

    const caret = pasteTextIntoComposer('that', target);

    expect(onChangeText).toHaveBeenCalledWith('fix that bug');
    expect(caret).toEqual({ start: 8, end: 8 });
  });

  it('replaces the range of an inverted selection', () => {
    const { onChangeText, target } = makeTarget('fix the bug', { start: 7, end: 4 });

    pasteTextIntoComposer('that', target);

    expect(onChangeText).toHaveBeenCalledWith('fix that bug');
  });

  it('appends when no selection was reported', () => {
    const { onChangeText, target } = makeTarget('fix', null);

    pasteTextIntoComposer(' it', target);

    expect(onChangeText).toHaveBeenCalledWith('fix it');
  });

  it('clamps a stale caret past the draft end to the end', () => {
    const { onChangeText, target } = makeTarget('fix', { start: 40, end: 40 });

    pasteTextIntoComposer('!', target);

    expect(onChangeText).toHaveBeenCalledWith('fix!');
  });

  it('truncates the pasted text, never the existing draft', () => {
    const { onChangeText, target } = makeTarget('abcde', { start: 2, end: 2 }, 7);

    const caret = pasteTextIntoComposer('XXXXX', target);

    expect(onChangeText).toHaveBeenCalledWith('abXXcde');
    expect(caret).toEqual({ start: 4, end: 4 });
  });

  it('keeps the draft untouched when the cap leaves no room', () => {
    const { onChangeText, target } = makeTarget('abcde', { start: 2, end: 2 }, 5);

    pasteTextIntoComposer('XXXXX', target);

    expect(onChangeText).toHaveBeenCalledWith('abcde');
  });

  it('still reports the draft when the input has not mounted', () => {
    const { onChangeText, target } = makeTarget('fix', null);

    pasteTextIntoComposer(' it', { ...target, input: null });

    expect(onChangeText).toHaveBeenCalledWith('fix it');
  });
});
